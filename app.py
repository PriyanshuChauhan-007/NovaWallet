"""
NovaWallet backend.

Stack: Flask + Flask-SQLAlchemy (SQLite by default) + Flask-JWT-Extended.

Design notes
------------
* All money is stored as INTEGER paise (1 INR = 100 paise) so we never suffer
  from floating point drift. The API still speaks rupees (floats) to clients.
* Every balance mutation is a *conditional* UPDATE, e.g.
      UPDATE wallets SET balance = balance - :amt
       WHERE user_id = :id AND balance >= :amt
  and we check ``rowcount``. This is race-free even with many concurrent
  requests, because the check and the write happen in one atomic statement.
  The debit, credit and ledger insert are committed together; any failure
  triggers ``db.session.rollback()`` so money is never created or destroyed.
* OTP challenges live in the database (hashed) and are bound to the exact
  receiver + amount they were issued for. They are consumed atomically inside
  the transfer transaction, so one OTP can never authorise two payments.
"""

import hashlib
import hmac
import json
import os
import random
import re
import secrets
import string
import time
import uuid
from datetime import datetime, timedelta, timezone
from decimal import Decimal, InvalidOperation
from typing import Any, Optional, cast

from flask import Flask, jsonify, render_template, request
from flask_cors import CORS
from flask_jwt_extended import (
    JWTManager,
    create_access_token,
    current_user,
    jwt_required,
)
from flask_sqlalchemy import SQLAlchemy
from sqlalchemy import CheckConstraint, delete, event, func, or_, update
from sqlalchemy.engine import Engine
from sqlalchemy.exc import IntegrityError, SQLAlchemyError
from werkzeug.security import check_password_hash, generate_password_hash

# --------------------------------------------------------------------------- #
# Configuration
# --------------------------------------------------------------------------- #
BASE_DIR = os.path.abspath(os.path.dirname(__file__))
INSTANCE_DIR = os.path.join(BASE_DIR, "instance")
os.makedirs(INSTANCE_DIR, exist_ok=True)

LEGACY_JSON_FILE = os.path.join(BASE_DIR, "wallet_data.json")
LEGACY_CREDENTIALS_FILE = os.path.join(INSTANCE_DIR, "legacy_credentials.txt")

# Business rules (all in paise)
PAISE = 100
MAX_TXN_PAISE = 50_000 * PAISE            # ₹50,000 per transaction
WALLET_LIMIT_PAISE = 100_000 * PAISE      # ₹1,00,000 wallet cap
DEFAULT_BANK_PAISE = 50_000 * PAISE       # Mock linked bank balance on signup
MAX_SPLIT_TOTAL_PAISE = 500_000 * PAISE   # ₹5,00,000 max bill to split
MAX_SPLIT_PARTICIPANTS = 20
MAX_PENDING_OUTGOING = 25                 # Anti-spam cap on open requests

OTP_TTL = timedelta(minutes=5)
OTP_MAX_ATTEMPTS = 5

SIMULATE_LATENCY = os.environ.get("NOVA_SIMULATE_LATENCY", "1") == "1"

USERNAME_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9 _.\-]{1,31}$")
EMAIL_RE = re.compile(r"^[^@\s]+@[^@\s]+\.[^@\s]+$")
PHONE_RE = re.compile(r"^\+?[0-9]{7,15}$")
CATEGORIES = {"Transfer", "Food", "Shopping", "Bills", "Travel", "Entertainment", "Other"}


def _load_or_create_secret(env_name: str, filename: str) -> str:
    """Use an env var in production; otherwise persist a random dev secret so
    tokens survive server restarts."""
    value = os.environ.get(env_name)
    if value:
        return value
    path = os.path.join(INSTANCE_DIR, filename)
    if os.path.exists(path):
        with open(path, "r", encoding="utf-8") as f:
            return f.read().strip()
    value = secrets.token_urlsafe(64)
    with open(path, "w", encoding="utf-8") as f:
        f.write(value)
    return value


app = Flask(__name__, instance_path=INSTANCE_DIR)
app.config.update(
    SQLALCHEMY_DATABASE_URI=os.environ.get(
        "DATABASE_URL", "sqlite:///" + os.path.join(INSTANCE_DIR, "novawallet.db")
    ),
    SQLALCHEMY_TRACK_MODIFICATIONS=False,
    JWT_SECRET_KEY=_load_or_create_secret("JWT_SECRET_KEY", ".jwt_secret"),
    JWT_ACCESS_TOKEN_EXPIRES=timedelta(hours=int(os.environ.get("JWT_EXPIRES_HOURS", "12"))),
    JSON_SORT_KEYS=False,
)
if app.config["SQLALCHEMY_DATABASE_URI"].startswith("sqlite"):
    # Wait up to 15s for a competing writer instead of failing immediately.
    app.config["SQLALCHEMY_ENGINE_OPTIONS"] = {"connect_args": {"timeout": 15}}

CORS(app)
db = SQLAlchemy(app)
jwt = JWTManager(app)


@event.listens_for(Engine, "connect")
def _sqlite_pragmas(dbapi_connection, _record):
    """Enforce foreign keys and enable WAL (readers don't block writers)."""
    import sqlite3

    if isinstance(dbapi_connection, sqlite3.Connection):
        cursor = dbapi_connection.cursor()
        cursor.execute("PRAGMA foreign_keys=ON")
        cursor.execute("PRAGMA journal_mode=WAL")
        cursor.close()


def utcnow() -> datetime:
    """Naive UTC timestamp (SQLite has no timezone support)."""
    return datetime.now(timezone.utc).replace(tzinfo=None)


# --------------------------------------------------------------------------- #
# Models
# --------------------------------------------------------------------------- #
class User(db.Model):
    __tablename__ = "users"

    id: Any = db.Column(db.Integer, primary_key=True)
    username: Any = db.Column(db.String(32), nullable=False)
    email: Any = db.Column(db.String(255))
    phone: Any = db.Column(db.String(20))
    password_hash: Any = db.Column(db.String(255), nullable=False)
    created_at: Any = db.Column(db.DateTime, nullable=False, default=utcnow)

    wallet: Any = db.relationship(
        "Wallet", back_populates="user", uselist=False, cascade="all, delete-orphan"
    )

    __table_args__ = (
        # Case-insensitive uniqueness: "Alice" and "alice" can't both exist.
        db.Index("ux_users_username_lower", func.lower(username), unique=True),
    )

    def __init__(
        self,
        username: str = "",
        email: str | None = None,
        phone: str | None = None,
        password_hash: str = "",
        created_at: datetime | None = None,
        wallet: Any = None,
        **kwargs: Any,
    ) -> None:
        super().__init__(**kwargs)
        if username:
            self.username = username
        if email is not None:
            self.email = email
        if phone is not None:
            self.phone = phone
        if password_hash:
            self.password_hash = password_hash
        if created_at is not None:
            self.created_at = created_at
        if wallet is not None:
            self.wallet = wallet
        for k, v in kwargs.items():
            setattr(self, k, v)

    def set_password(self, raw: str) -> None:
        self.password_hash = generate_password_hash(raw)

    def check_password(self, raw: str) -> bool:
        return check_password_hash(self.password_hash, raw)


class Wallet(db.Model):
    __tablename__ = "wallets"

    id: Any = db.Column(db.Integer, primary_key=True)
    user_id: Any = db.Column(
        db.Integer, db.ForeignKey("users.id", ondelete="CASCADE"), unique=True, nullable=False
    )
    balance_paise: Any = db.Column(db.Integer, nullable=False, default=0)
    bank_balance_paise: Any = db.Column(db.Integer, nullable=False, default=DEFAULT_BANK_PAISE)
    updated_at: Any = db.Column(db.DateTime, nullable=False, default=utcnow, onupdate=utcnow)

    user: Any = db.relationship("User", back_populates="wallet")

    __table_args__ = (
        # Last line of defence: the DB itself refuses negative balances.
        CheckConstraint("balance_paise >= 0", name="ck_wallet_balance_non_negative"),
        CheckConstraint("bank_balance_paise >= 0", name="ck_bank_balance_non_negative"),
    )

    def __init__(
        self,
        user_id: int | None = None,
        balance_paise: int = 0,
        bank_balance_paise: int = DEFAULT_BANK_PAISE,
        updated_at: datetime | None = None,
        user: Any = None,
        **kwargs: Any,
    ) -> None:
        super().__init__(**kwargs)
        if user_id is not None:
            self.user_id = user_id
        self.balance_paise = balance_paise
        self.bank_balance_paise = bank_balance_paise
        if updated_at is not None:
            self.updated_at = updated_at
        if user is not None:
            self.user = user
        for k, v in kwargs.items():
            setattr(self, k, v)


class Transaction(db.Model):
    """Immutable ledger entry. ``sender`` is NULL for bank loads."""

    __tablename__ = "transactions"

    KIND_LOAD: str = "LOAD"
    KIND_TRANSFER: str = "TRANSFER"

    id: Any = db.Column(db.Integer, primary_key=True)
    txn_id: Any = db.Column(db.String(20), unique=True, nullable=False, index=True)
    sender_id: Any = db.Column(db.Integer, db.ForeignKey("users.id"), index=True)
    receiver_id: Any = db.Column(db.Integer, db.ForeignKey("users.id"), nullable=False, index=True)
    amount_paise: Any = db.Column(db.Integer, nullable=False)
    category: Any = db.Column(db.String(32), nullable=False, default="Transfer")
    kind: Any = db.Column(db.String(16), nullable=False, default=KIND_TRANSFER)
    note: Any = db.Column(db.String(140))
    timestamp: Any = db.Column(db.DateTime, nullable=False, default=utcnow, index=True)

    sender: Any = db.relationship("User", foreign_keys=[sender_id])
    receiver: Any = db.relationship("User", foreign_keys=[receiver_id])

    __table_args__ = (CheckConstraint("amount_paise > 0", name="ck_txn_amount_positive"),)

    def __init__(
        self,
        txn_id: str = "",
        sender_id: int | None = None,
        receiver_id: int | None = None,
        amount_paise: int = 0,
        category: str = "Transfer",
        kind: str = "TRANSFER",
        note: str | None = None,
        timestamp: datetime | None = None,
        sender: Any = None,
        receiver: Any = None,
        **kwargs: Any,
    ) -> None:
        super().__init__(**kwargs)
        if txn_id:
            self.txn_id = txn_id
        self.sender_id = sender_id
        if receiver_id is not None:
            self.receiver_id = receiver_id
        self.amount_paise = amount_paise
        self.category = category
        self.kind = kind
        if note is not None:
            self.note = note
        if timestamp is not None:
            self.timestamp = timestamp
        if sender is not None:
            self.sender = sender
        if receiver is not None:
            self.receiver = receiver
        for k, v in kwargs.items():
            setattr(self, k, v)


class PaymentRequest(db.Model):
    """'Requester asks Payer for money'. Split bills create one per participant."""

    __tablename__ = "payment_requests"

    PENDING: str = "PENDING"
    APPROVED: str = "APPROVED"
    DECLINED: str = "DECLINED"
    CANCELLED: str = "CANCELLED"

    id: Any = db.Column(db.Integer, primary_key=True)
    request_id: Any = db.Column(db.String(20), unique=True, nullable=False, index=True)
    requester_id: Any = db.Column(db.Integer, db.ForeignKey("users.id"), nullable=False, index=True)
    payer_id: Any = db.Column(db.Integer, db.ForeignKey("users.id"), nullable=False, index=True)
    amount_paise: Any = db.Column(db.Integer, nullable=False)
    category: Any = db.Column(db.String(32), nullable=False, default="Transfer")
    note: Any = db.Column(db.String(140))
    status: Any = db.Column(db.String(12), nullable=False, default=PENDING, index=True)
    split_id: Any = db.Column(db.String(20), index=True)
    txn_id: Any = db.Column(db.String(20))
    created_at: Any = db.Column(db.DateTime, nullable=False, default=utcnow)
    resolved_at: Any = db.Column(db.DateTime)

    requester: Any = db.relationship("User", foreign_keys=[requester_id])
    payer: Any = db.relationship("User", foreign_keys=[payer_id])

    __table_args__ = (CheckConstraint("amount_paise > 0", name="ck_req_amount_positive"),)

    def __init__(
        self,
        request_id: str = "",
        requester_id: int | None = None,
        payer_id: int | None = None,
        amount_paise: int = 0,
        category: str = "Transfer",
        note: str | None = None,
        status: str = "PENDING",
        split_id: str | None = None,
        txn_id: str | None = None,
        created_at: datetime | None = None,
        resolved_at: datetime | None = None,
        requester: Any = None,
        payer: Any = None,
        **kwargs: Any,
    ) -> None:
        super().__init__(**kwargs)
        if request_id:
            self.request_id = request_id
        if requester_id is not None:
            self.requester_id = requester_id
        if payer_id is not None:
            self.payer_id = payer_id
        self.amount_paise = amount_paise
        self.category = category
        if note is not None:
            self.note = note
        self.status = status
        if split_id is not None:
            self.split_id = split_id
        if txn_id is not None:
            self.txn_id = txn_id
        if created_at is not None:
            self.created_at = created_at
        if resolved_at is not None:
            self.resolved_at = resolved_at
        if requester is not None:
            self.requester = requester
        if payer is not None:
            self.payer = payer
        for k, v in kwargs.items():
            setattr(self, k, v)


class OtpChallenge(db.Model):
    """One active OTP per user, bound to a specific payment."""

    __tablename__ = "otp_challenges"

    PURPOSE_PAY: str = "PAY"
    PURPOSE_APPROVE: str = "APPROVE"

    user_id: Any = db.Column(db.Integer, db.ForeignKey("users.id", ondelete="CASCADE"), primary_key=True)
    code_hash: Any = db.Column(db.String(64), nullable=False)
    purpose: Any = db.Column(db.String(12), nullable=False)
    receiver_id: Any = db.Column(db.Integer, db.ForeignKey("users.id"))
    amount_paise: Any = db.Column(db.Integer, nullable=False)
    request_id: Any = db.Column(db.String(20))
    attempts: Any = db.Column(db.Integer, nullable=False, default=0)
    expires_at: Any = db.Column(db.DateTime, nullable=False)

    def __init__(
        self,
        user_id: int | None = None,
        code_hash: str = "",
        purpose: str = "",
        receiver_id: int | None = None,
        amount_paise: int = 0,
        request_id: str | None = None,
        attempts: int = 0,
        expires_at: datetime | None = None,
        **kwargs: Any,
    ) -> None:
        super().__init__(**kwargs)
        if user_id is not None:
            self.user_id = user_id
        if code_hash:
            self.code_hash = code_hash
        if purpose:
            self.purpose = purpose
        self.receiver_id = receiver_id
        self.amount_paise = amount_paise
        self.request_id = request_id
        self.attempts = attempts
        if expires_at is not None:
            self.expires_at = expires_at
        for k, v in kwargs.items():
            setattr(self, k, v)


# --------------------------------------------------------------------------- #
# Helpers
# --------------------------------------------------------------------------- #
class TransferError(Exception):
    def __init__(self, msg: str, code: int = 400):
        super().__init__(msg)
        self.msg = msg
        self.code = code


def ok(msg: str = "OK", **extra):
    return jsonify({"status": "success", "msg": msg, **extra})


def err(msg: str, code: int = 400, **extra):
    return jsonify({"status": "error", "msg": msg, **extra}), code


def simulate_latency(seconds: float) -> None:
    """Keeps the original 'secure processing' UX feel. Disable in production
    with NOVA_SIMULATE_LATENCY=0."""
    if SIMULATE_LATENCY:
        time.sleep(seconds)


def json_body() -> dict:
    data = request.get_json(silent=True)
    return data if isinstance(data, dict) else {}


def _random_id(prefix: str) -> str:
    return prefix + "".join(random.SystemRandom().choices(string.ascii_uppercase + string.digits, k=8))


def generate_txn_id() -> str:
    return _random_id("TXN-")


def generate_request_id() -> str:
    return _random_id("REQ-")


def parse_amount(raw, max_paise: int = MAX_TXN_PAISE, label: str = "Amount") -> int:
    """Convert a user-supplied rupee value into paise, with strict validation."""
    try:
        value = Decimal(str(raw).strip())
    except (InvalidOperation, AttributeError):
        raise ValueError("Invalid amount format!")
    if not value.is_finite():
        raise ValueError("Invalid amount format!")
    if value != value.quantize(Decimal("0.01")):
        raise ValueError("Amount can have at most 2 decimal places.")
    paise = int(value * PAISE)
    if paise < PAISE or paise > max_paise:
        raise ValueError(f"{label} must be between ₹1 and {fmt_inr(max_paise)}")
    return paise


def to_rupees(paise: int) -> float:
    return round((paise or 0) / PAISE, 2)


def fmt_inr(paise: int) -> str:
    """Indian digit grouping, e.g. 1,00,000.50 -> '₹1,00,000.50'."""
    rupees, p = divmod(int(paise), PAISE)
    s = str(rupees)
    if len(s) > 3:
        head, tail = s[:-3], s[-3:]
        head = ",".join([head[max(i - 2, 0):i] for i in range(len(head), 0, -2)][::-1])
        s = f"{head},{tail}"
    return f"₹{s}" + (f".{p:02d}" if p else "")


def iso(dt: datetime | None) -> str | None:
    return dt.replace(microsecond=0).isoformat() + "Z" if dt else None


def find_user(username: str) -> User | None:
    username = (username or "").strip()
    if not username:
        return None
    return User.query.filter(func.lower(User.username) == username.lower()).first()


def clean_category(raw) -> str:
    cat = str(raw or "Transfer").strip()
    return cat if cat in CATEGORIES else "Transfer"


def clean_note(raw) -> str | None:
    note = str(raw or "").strip()
    return note[:140] or None


def hash_otp(code: str) -> str:
    key = app.config["JWT_SECRET_KEY"].encode()
    return hmac.new(key, code.encode(), hashlib.sha256).hexdigest()


def issue_otp(user: User, purpose: str, receiver_id: int, amount_paise: int, request_id=None) -> None:
    """Create (or replace) the user's OTP challenge and 'send' it via mock SMS."""
    code = f"{secrets.randbelow(9000) + 1000}"
    challenge = db.session.get(OtpChallenge, user.id) or OtpChallenge(user_id=user.id)
    challenge.code_hash = hash_otp(code)
    challenge.purpose = purpose
    challenge.receiver_id = receiver_id
    challenge.amount_paise = amount_paise
    challenge.request_id = request_id
    challenge.attempts = 0
    challenge.expires_at = utcnow() + OTP_TTL
    db.session.add(challenge)
    db.session.commit()

    # PROFESSIONAL MOCK SMS GATEWAY LOGGING
    print("\n" + "=" * 55)
    print(f"[SYSTEM LOG] - {datetime.now().strftime('%Y-%m-%d %H:%M:%S')}")
    print("[MOCK SMS API] Intercepted outgoing OTP request.")
    print(f"[DESTINATION] User: {user.username} ({user.phone or 'no phone on file'})")
    print(f"[PAYLOAD] Your NovaWallet Security Code is: {code}")
    print(f"[CONTEXT] {purpose} {fmt_inr(amount_paise)} | valid {int(OTP_TTL.total_seconds() // 60)} min")
    print("[STATUS] 200 OK - Message logged to secure terminal.")
    print("=" * 55 + "\n", flush=True)


def verify_otp(user: User, code: str, purpose: str, receiver_id: int, amount_paise: int, request_id=None):
    """Validate the OTP without consuming it. Returns (challenge, error_response)."""
    challenge = db.session.get(OtpChallenge, user.id)
    if not challenge or challenge.purpose != purpose:
        return None, err("No active OTP. Please generate a new one.")
    if challenge.expires_at < utcnow():
        db.session.delete(challenge)
        db.session.commit()
        return None, err("OTP expired. Please generate a new one.")
    if challenge.attempts >= OTP_MAX_ATTEMPTS:
        db.session.delete(challenge)
        db.session.commit()
        return None, err("Too many wrong attempts. Please generate a new OTP.", 429)
    if (
        challenge.receiver_id != receiver_id
        or challenge.amount_paise != amount_paise
        or challenge.request_id != request_id
    ):
        return None, err("Payment details changed after the OTP was issued. Please generate a new OTP.")
    if not hmac.compare_digest(challenge.code_hash, hash_otp(str(code or "").strip())):
        challenge.attempts += 1
        left = OTP_MAX_ATTEMPTS - challenge.attempts
        db.session.commit()
        # 400 (not 401) so the client doesn't treat it as an expired session.
        return None, err(f"Invalid OTP Code! {left} attempt{'s' if left != 1 else ''} left.")
    return challenge, None


def consume_otp(challenge: OtpChallenge) -> None:
    """Atomically delete the exact challenge we verified. If a concurrent request
    already used it, rowcount is 0 and the surrounding transaction is aborted."""
    result = db.session.execute(
        delete(OtpChallenge)
        .where(OtpChallenge.user_id == challenge.user_id, OtpChallenge.code_hash == challenge.code_hash)
        .execution_options(synchronize_session=False)
    )
    if getattr(result, "rowcount", 0) != 1:
        raise TransferError("This OTP has already been used.", 409)


def _adjust_wallet(user_id: int, delta: int) -> bool:
    """Conditional, atomic balance change. Returns False if the rule fails."""
    stmt = update(Wallet).where(Wallet.user_id == user_id)
    if delta < 0:
        stmt = stmt.where(Wallet.balance_paise >= -delta)
    else:
        stmt = stmt.where(Wallet.balance_paise + delta <= WALLET_LIMIT_PAISE)
    stmt = stmt.values(balance_paise=Wallet.balance_paise + delta, updated_at=utcnow())
    result = db.session.execute(stmt.execution_options(synchronize_session=False))
    return getattr(result, "rowcount", 0) == 1


def execute_transfer(sender: User, receiver: User, amount_paise: int, category: str, note=None) -> Transaction:
    """Move money between wallets. MUST run inside a transaction that the caller
    commits (or rolls back on TransferError / SQLAlchemyError)."""
    if sender.id == receiver.id:
        raise TransferError("You cannot send money to yourself.")

    # Lock rows in a consistent (id) order to avoid deadlocks on row-locking DBs.
    steps = sorted([(sender.id, -amount_paise), (receiver.id, amount_paise)], key=lambda s: s[0])
    for user_id, delta in steps:
        if not _adjust_wallet(user_id, delta):
            if delta < 0:
                raise TransferError("Insufficient Wallet Funds!")
            raise TransferError("Receiver's wallet cannot hold more than ₹1 Lakh!")

    txn = Transaction(
        txn_id=generate_txn_id(),
        sender_id=sender.id,
        receiver_id=receiver.id,
        amount_paise=amount_paise,
        category=category,
        kind=Transaction.KIND_TRANSFER,
        note=note,
    )
    db.session.add(txn)
    db.session.flush()  # Surface IntegrityErrors (e.g. txn_id clash) before commit.
    return txn


def serialize_txn(t: Transaction, me_id: int) -> dict:
    is_credit = t.receiver_id == me_id
    if t.kind == Transaction.KIND_LOAD:
        desc, counterparty = "Loaded from Bank", None
    elif is_credit:
        counterparty = t.sender.username if t.sender else "Unknown"
        desc = f"Received from {counterparty}"
    else:
        counterparty = t.receiver.username
        desc = f"Paid to {counterparty}"
    return {
        "txn_id": t.txn_id,
        "type": "CREDIT" if is_credit else "DEBIT",
        "kind": t.kind,
        "category": t.category,
        "desc": desc,
        "counterparty": counterparty,
        "note": t.note,
        "amount": to_rupees(t.amount_paise),
        "timestamp": iso(t.timestamp),
    }


def serialize_request(r: PaymentRequest) -> dict:
    return {
        "request_id": r.request_id,
        "requester": r.requester.username,
        "payer": r.payer.username,
        "amount": to_rupees(r.amount_paise),
        "category": r.category,
        "note": r.note,
        "status": r.status,
        "split_id": r.split_id,
        "txn_id": r.txn_id,
        "created_at": iso(r.created_at),
        "resolved_at": iso(r.resolved_at),
    }


def user_snapshot(user: User, history_limit: int = 500) -> dict:
    wallet = user.wallet
    total_in = (
        db.session.query(func.coalesce(func.sum(Transaction.amount_paise), 0))
        .filter(Transaction.receiver_id == user.id)
        .scalar()
    )
    total_out = (
        db.session.query(func.coalesce(func.sum(Transaction.amount_paise), 0))
        .filter(Transaction.sender_id == user.id)
        .scalar()
    )
    txns = (
        Transaction.query.filter(or_(Transaction.sender_id == user.id, Transaction.receiver_id == user.id))
        .order_by(Transaction.timestamp.desc(), Transaction.id.desc())
        .limit(history_limit)
        .all()
    )
    incoming = (
        PaymentRequest.query.filter_by(payer_id=user.id, status=PaymentRequest.PENDING)
        .order_by(PaymentRequest.created_at.desc())
        .all()
    )
    outgoing = (
        PaymentRequest.query.filter_by(requester_id=user.id)
        .order_by(PaymentRequest.created_at.desc())
        .limit(20)
        .all()
    )
    return {
        "username": user.username,
        "email": user.email,
        "phone": user.phone,
        "wallet_balance": to_rupees(wallet.balance_paise),
        "bank_balance": to_rupees(wallet.bank_balance_paise),
        "stats": {"in": to_rupees(total_in), "out": to_rupees(total_out)},
        "history": [serialize_txn(t, user.id) for t in txns],
        "requests": {
            "incoming": [serialize_request(r) for r in incoming],
            "outgoing": [serialize_request(r) for r in outgoing],
        },
    }


def commit_or_error(fn):
    """Run ``fn`` (which stages DB changes) and commit atomically, rolling back
    on any failure. ``fn`` returns the success response."""
    try:
        response = fn()
        db.session.commit()
        return response
    except TransferError as e:
        db.session.rollback()
        return err(e.msg, e.code)
    except IntegrityError:
        db.session.rollback()
        app.logger.exception("Integrity error during transaction")
        return err("Transaction conflict. Nothing was charged — please retry.", 409)
    except SQLAlchemyError:
        db.session.rollback()
        app.logger.exception("Database error during transaction")
        return err("Transaction failed and was rolled back. Nothing was charged.", 500)


# --------------------------------------------------------------------------- #
# JWT wiring
# --------------------------------------------------------------------------- #
@jwt.user_lookup_loader
def _load_user(_jwt_header, jwt_data):
    return db.session.get(User, int(jwt_data["sub"]))


@jwt.user_lookup_error_loader
def _user_lookup_error(_jwt_header, _jwt_data):
    return err("Account no longer exists. Please sign in again.", 401, auth_error=True)


@jwt.expired_token_loader
def _expired_token(_jwt_header, _jwt_data):
    return err("Session expired. Please sign in again.", 401, auth_error=True)


@jwt.invalid_token_loader
def _invalid_token(reason):
    return err("Invalid session token. Please sign in again.", 401, auth_error=True)


@jwt.unauthorized_loader
def _missing_token(reason):
    return err("Authentication required. Please sign in.", 401, auth_error=True)


def issue_token(user: User) -> str:
    return create_access_token(identity=str(user.id), additional_claims={"username": user.username})


# --------------------------------------------------------------------------- #
# Routes: pages & auth
# --------------------------------------------------------------------------- #
@app.route("/")
def index():
    return render_template("index.html")


@app.route("/api/signup", methods=["POST"])
def signup():
    simulate_latency(0.8)
    info = json_body()
    name = str(info.get("user", "")).strip()
    email = str(info.get("email", "")).strip()
    phone = str(info.get("phone", "")).strip().replace(" ", "")
    password = str(info.get("password", ""))

    if not name:
        return err("Username missing!")
    if not USERNAME_RE.match(name):
        return err("Username must be 2-32 characters: letters, numbers, spaces, '.', '_' or '-'.")
    if not email or not phone:
        return err("Email and Phone are required for signup!")
    if not EMAIL_RE.match(email):
        return err("Please enter a valid email address.")
    if not PHONE_RE.match(phone):
        return err("Please enter a valid phone number (7-15 digits).")
    if len(password) < 8:
        return err("Password must be at least 8 characters long.")
    if find_user(name):
        return err("User already exists!")

    user = User(username=name, email=email, phone=phone)
    user.set_password(password)
    user.wallet = Wallet(balance_paise=0, bank_balance_paise=DEFAULT_BANK_PAISE)
    db.session.add(user)
    try:
        db.session.commit()
    except IntegrityError:  # Lost a race with a simultaneous signup.
        db.session.rollback()
        return err("User already exists!")

    return ok("Wallet created and Bank linked!", access_token=issue_token(user), username=user.username)


# Pre-computed so failed lookups take the same time as wrong passwords
# (prevents username enumeration via response timing).
_DUMMY_HASH = generate_password_hash(secrets.token_hex(16))


@app.route("/api/login", methods=["POST"])
def login():
    simulate_latency(0.6)
    info = json_body()
    name = str(info.get("user", "")).strip()
    password = str(info.get("password", ""))
    if not name or not password:
        return err("Username and password are required.")

    user = find_user(name)
    if not user:
        check_password_hash(_DUMMY_HASH, password)
        return err("Invalid username or password.", 401)
    if not user.check_password(password):
        return err("Invalid username or password.", 401)

    return ok("Welcome back!", access_token=issue_token(user), username=user.username)


@app.route("/api/me", methods=["GET"])
@jwt_required()
def me():
    return ok(data=user_snapshot(current_user))


@app.route("/api/users/search", methods=["GET"])
@jwt_required()
def search_users():
    q = request.args.get("q", "").strip().lower()
    if not q:
        return ok(users=[])
    escaped = q.replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_")
    users = (
        User.query.filter(func.lower(User.username).like(f"{escaped}%", escape="\\"), User.id != current_user.id)
        .order_by(func.lower(User.username))
        .limit(8)
        .all()
    )
    return ok(users=[u.username for u in users])


# --------------------------------------------------------------------------- #
# Routes: money movement
# --------------------------------------------------------------------------- #
@app.route("/api/deposit", methods=["POST"])
@jwt_required()
def deposit():
    simulate_latency(0.8)
    try:
        amt = parse_amount(json_body().get("amount", 0))
    except ValueError as e:
        return err(str(e))

    user = current_user

    def work():
        result = db.session.execute(
            update(Wallet)
            .where(
                Wallet.user_id == user.id,
                Wallet.bank_balance_paise >= amt,
                Wallet.balance_paise + amt <= WALLET_LIMIT_PAISE,
            )
            .values(
                bank_balance_paise=Wallet.bank_balance_paise - amt,
                balance_paise=Wallet.balance_paise + amt,
                updated_at=utcnow(),
            )
            .execution_options(synchronize_session=False)
        )
        if getattr(result, "rowcount", 0) != 1:
            wallet = db.session.get(Wallet, user.wallet.id, populate_existing=True)
            if wallet and wallet.balance_paise + amt > WALLET_LIMIT_PAISE:
                raise TransferError("Wallet limit of ₹1,00,000 exceeded!")
            raise TransferError("Insufficient Bank Funds!")

        db.session.add(
            Transaction(
                txn_id=generate_txn_id(),
                sender_id=None,
                receiver_id=user.id,
                amount_paise=amt,
                category="Bank Load",
                kind=Transaction.KIND_LOAD,
            )
        )
        return ok("Bank Transfer Successful!")

    return commit_or_error(work)


@app.route("/api/request_pay_otp", methods=["POST"])
@jwt_required()
def request_pay_otp():
    """Issue an OTP for either a direct payment ({to, amount}) or for approving
    a pending payment request ({request_id})."""
    simulate_latency(0.5)
    body = json_body()
    user = current_user

    request_id = str(body.get("request_id", "")).strip()
    if request_id:
        pr = PaymentRequest.query.filter_by(request_id=request_id, payer_id=user.id).first()
        if not pr or pr.status != PaymentRequest.PENDING:
            return err("This request is no longer pending.", 404)
        if user.wallet.balance_paise < pr.amount_paise:
            return err("Insufficient Wallet Funds!")
        issue_otp(user, OtpChallenge.PURPOSE_APPROVE, pr.requester_id, pr.amount_paise, pr.request_id)
        return ok("OTP Generated via Mock SMS Gateway!")

    receiver = find_user(body.get("to", ""))
    if not receiver:
        return err("Recipient not found! Check spelling.", 404)
    if receiver.id == user.id:
        return err("You cannot send money to yourself.")
    try:
        amt = parse_amount(body.get("amount", 0), label="Transfer")
    except ValueError as e:
        return err(str(e))
    if user.wallet.balance_paise < amt:
        return err("Insufficient Wallet Funds!")

    issue_otp(user, OtpChallenge.PURPOSE_PAY, receiver.id, amt)
    return ok("OTP Generated via Mock SMS Gateway!")


@app.route("/api/confirm_pay", methods=["POST"])
@jwt_required()
def confirm_pay():
    simulate_latency(1.2)
    body = json_body()
    sender = current_user
    receiver = find_user(body.get("to", ""))
    if not receiver:
        return err("Recipient not found! Check spelling.", 404)
    try:
        amt = parse_amount(body.get("amount", 0), label="Transfer")
    except ValueError as e:
        return err(str(e))

    otp_code = str(body.get("otp") or "")
    challenge, error = verify_otp(sender, otp_code, OtpChallenge.PURPOSE_PAY, receiver.id, amt)
    if error or challenge is None:
        return error or err("Invalid OTP code!")

    category = clean_category(body.get("category"))
    note = clean_note(body.get("note"))

    def work():
        consume_otp(challenge)
        txn = execute_transfer(sender, receiver, amt, category, note)
        return ok(f"Success! ID: {txn.txn_id}", txn_id=txn.txn_id)

    return commit_or_error(work)


# --------------------------------------------------------------------------- #
# Routes: payment requests & split bills
# --------------------------------------------------------------------------- #
def _pending_outgoing_count(user_id: int) -> int:
    return PaymentRequest.query.filter_by(requester_id=user_id, status=PaymentRequest.PENDING).count()


@app.route("/api/request_money", methods=["POST"])
@jwt_required()
def request_money():
    """Current user (requester) asks ``payer`` for ``amount``."""
    simulate_latency(0.5)
    body = json_body()
    requester = current_user
    payer = find_user(body.get("payer", ""))
    if not payer:
        return err("User not found! Check spelling.", 404)
    if payer.id == requester.id:
        return err("You cannot request money from yourself.")
    try:
        amt = parse_amount(body.get("amount", 0))
    except ValueError as e:
        return err(str(e))
    if _pending_outgoing_count(requester.id) >= MAX_PENDING_OUTGOING:
        return err(f"You already have {MAX_PENDING_OUTGOING} open requests. Cancel some first.", 429)

    def work():
        pr = PaymentRequest(
            request_id=generate_request_id(),
            requester_id=requester.id,
            payer_id=payer.id,
            amount_paise=amt,
            category=clean_category(body.get("category")),
            note=clean_note(body.get("note")),
        )
        db.session.add(pr)
        db.session.flush()
        return ok(f"Requested {fmt_inr(amt)} from {payer.username}", request=serialize_request(pr))

    return commit_or_error(work)


@app.route("/api/requests", methods=["GET"])
@jwt_required()
def list_requests():
    return ok(data=user_snapshot(current_user, history_limit=0)["requests"])


def _transition_request(request_id: str, actor_filter, new_status: str):
    """Atomically move a PENDING request to ``new_status``. The WHERE clause
    guarantees a request can only ever be resolved once."""
    result = db.session.execute(
        update(PaymentRequest)
        .where(
            PaymentRequest.request_id == request_id,
            PaymentRequest.status == PaymentRequest.PENDING,
            actor_filter,
        )
        .values(status=new_status, resolved_at=utcnow())
        .execution_options(synchronize_session=False)
    )
    if getattr(result, "rowcount", 0) != 1:
        raise TransferError("This request is no longer pending.", 409)


@app.route("/api/requests/<request_id>/approve", methods=["POST"])
@jwt_required()
def approve_request(request_id):
    simulate_latency(1.0)
    payer = current_user
    pr = PaymentRequest.query.filter_by(request_id=request_id, payer_id=payer.id).first()
    if not pr or pr.status != PaymentRequest.PENDING:
        return err("This request is no longer pending.", 404)

    otp_code = str(json_body().get("otp") or "")
    challenge, error = verify_otp(
        payer, otp_code, OtpChallenge.PURPOSE_APPROVE, pr.requester_id, pr.amount_paise, pr.request_id
    )
    if error or challenge is None:
        return error or err("Invalid OTP code!")

    requester = pr.requester

    def work():
        consume_otp(challenge)
        _transition_request(request_id, PaymentRequest.payer_id == payer.id, PaymentRequest.APPROVED)
        txn = execute_transfer(payer, requester, pr.amount_paise, pr.category, pr.note or "Payment request")
        db.session.execute(
            update(PaymentRequest)
            .where(PaymentRequest.id == pr.id)
            .values(txn_id=txn.txn_id)
            .execution_options(synchronize_session=False)
        )
        return ok(f"Paid {fmt_inr(pr.amount_paise)} to {requester.username}. ID: {txn.txn_id}", txn_id=txn.txn_id)

    return commit_or_error(work)


@app.route("/api/requests/<request_id>/decline", methods=["POST"])
@jwt_required()
def decline_request(request_id):
    simulate_latency(0.4)
    payer_id = current_user.id

    def work():
        _transition_request(request_id, PaymentRequest.payer_id == payer_id, PaymentRequest.DECLINED)
        return ok("Request declined.")

    return commit_or_error(work)


@app.route("/api/requests/<request_id>/cancel", methods=["POST"])
@jwt_required()
def cancel_request(request_id):
    simulate_latency(0.4)
    requester_id = current_user.id

    def work():
        _transition_request(request_id, PaymentRequest.requester_id == requester_id, PaymentRequest.CANCELLED)
        return ok("Request cancelled.")

    return commit_or_error(work)


def split_equally(total_paise: int, parts: int) -> list[int]:
    """Split into ``parts`` shares that differ by at most 1 paisa and always sum
    exactly to ``total_paise``. Earlier shares absorb the remainder."""
    base, remainder = divmod(total_paise, parts)
    return [base + (1 if i < remainder else 0) for i in range(parts)]


@app.route("/api/split_bill", methods=["POST"])
@jwt_required()
def split_bill():
    simulate_latency(0.8)
    body = json_body()
    me_user = current_user

    try:
        total = parse_amount(body.get("total", 0), max_paise=MAX_SPLIT_TOTAL_PAISE, label="Bill total")
    except ValueError as e:
        return err(str(e))

    raw_names = body.get("usernames") or []
    if not isinstance(raw_names, list):
        return err("Participants must be a list of usernames.")
    include_self = bool(body.get("include_self", True))

    participants, seen, missing = [], set(), []
    for raw in raw_names:
        u = find_user(str(raw))
        if not u:
            missing.append(str(raw))
        elif u.id != me_user.id and u.id not in seen:
            seen.add(u.id)
            participants.append(u)
    if missing:
        return err(f"User(s) not found: {', '.join(missing[:5])}", 404)
    if not participants:
        return err("Select at least one other person to split with.")

    people = len(participants) + (1 if include_self else 0)
    if people < 2:
        return err("A split needs at least 2 people.")
    if len(participants) > MAX_SPLIT_PARTICIPANTS:
        return err(f"You can split with at most {MAX_SPLIT_PARTICIPANTS} people.")
    if _pending_outgoing_count(me_user.id) + len(participants) > MAX_PENDING_OUTGOING:
        return err(f"This would exceed your limit of {MAX_PENDING_OUTGOING} open requests.", 429)

    shares = split_equally(total, people)
    my_share = shares.pop(0) if include_self else 0  # You absorb any leftover paisa.
    if any(s < PAISE for s in shares):
        return err("Each share must be at least ₹1.")
    if any(s > MAX_TXN_PAISE for s in shares):
        return err(f"Each share must be at most {fmt_inr(MAX_TXN_PAISE)}.")

    split_id = _random_id("SPL-")
    note = clean_note(body.get("note")) or "Split bill"
    category = clean_category(body.get("category"))

    def work():
        created = []
        for user, share in zip(participants, shares):
            pr = PaymentRequest(
                request_id=generate_request_id(),
                requester_id=me_user.id,
                payer_id=user.id,
                amount_paise=share,
                category=category,
                note=note,
                split_id=split_id,
            )
            db.session.add(pr)
            created.append(pr)
        db.session.flush()
        return ok(
            f"Split {fmt_inr(total)} — sent {len(created)} request{'s' if len(created) != 1 else ''}!",
            split_id=split_id,
            your_share=to_rupees(my_share),
            requests=[serialize_request(r) for r in created],
        )

    return commit_or_error(work)


# --------------------------------------------------------------------------- #
# One-time migration from the legacy wallet_data.json
# --------------------------------------------------------------------------- #
_LEGACY_RE = re.compile(r"^(Paid|Received|Loaded)\s+₹([\d.]+)\s+(?:to|from)\s+(.+)$")


def _parse_legacy_dt(raw: str) -> datetime:
    """Legacy dates look like '19 Apr, 22:28' (local time, no year)."""
    try:
        now_local = datetime.now()
        dt = datetime.strptime(f"{raw} {now_local.year}", "%d %b, %H:%M %Y")
        if dt > now_local:
            dt = dt.replace(year=dt.year - 1)
        return dt.astimezone(timezone.utc).replace(tzinfo=None)
    except (ValueError, TypeError):
        return utcnow()


def import_legacy_json(path: str = LEGACY_JSON_FILE) -> int:
    """Import users, balances and de-duplicated transactions from the old JSON
    store. Legacy accounts had no passwords, so each gets a random temporary
    password written to instance/legacy_credentials.txt. Runs in one atomic
    transaction. Returns the number of users imported."""
    if not os.path.exists(path):
        return 0
    with open(path, "r", encoding="utf-8") as f:
        data = json.load(f)

    credentials, users = [], {}
    try:
        for name, rec in data.items():
            name = name.strip()
            temp_password = secrets.token_urlsafe(9)
            user = User(username=name, email=rec.get("email"), phone=rec.get("phone"))
            user.set_password(temp_password)
            wallet_rupees = rec.get("wallet_balance", rec.get("balance", 0.0))
            user.wallet = Wallet(
                balance_paise=int(round(float(wallet_rupees) * PAISE)),
                bank_balance_paise=int(round(float(rec.get("bank_balance", 50000.0)) * PAISE)),
            )
            db.session.add(user)
            users[name] = user
            credentials.append((name, temp_password))
        db.session.flush()

        seen_txns = set()
        for name, rec in data.items():
            owner = users[name.strip()]
            for entry in rec.get("history", []):
                txn_id = entry.get("txn_id") or generate_txn_id()
                if txn_id in seen_txns:
                    continue  # Transfers were stored twice (sender + receiver copy).
                match = _LEGACY_RE.match(entry.get("desc", "").strip())
                if not match:
                    continue
                verb, amount, other = match.group(1), match.group(2), match.group(3).strip()
                paise = int(round(float(amount) * PAISE))
                ts = _parse_legacy_dt(entry.get("dt"))
                if verb == "Loaded":
                    txn = Transaction(txn_id=txn_id, sender_id=None, receiver_id=owner.id, amount_paise=paise,
                                      category="Bank Load", kind=Transaction.KIND_LOAD, timestamp=ts)
                else:
                    counterparty = users.get(other)
                    if not counterparty:
                        app.logger.warning("Skipping legacy txn %s: unknown user %r", txn_id, other)
                        continue
                    sender, receiver = (owner, counterparty) if verb == "Paid" else (counterparty, owner)
                    txn = Transaction(txn_id=txn_id, sender_id=sender.id, receiver_id=receiver.id, amount_paise=paise,
                                      category=entry.get("category") or "Transfer",
                                      kind=Transaction.KIND_TRANSFER, timestamp=ts)
                db.session.add(txn)
                seen_txns.add(txn_id)
        db.session.commit()
    except Exception:
        db.session.rollback()
        raise

    with open(LEGACY_CREDENTIALS_FILE, "w", encoding="utf-8") as f:
        f.write("# NovaWallet legacy account temporary passwords (generated during JSON -> SQLite migration)\n")
        f.write("# Share each password only with its owner. Delete this file afterwards.\n")
        for name, pw in credentials:
            f.write(f"{name}\t{pw}\n")

    print("\n" + "=" * 55)
    print(f"[MIGRATION] Imported {len(credentials)} legacy users from wallet_data.json")
    print(f"[MIGRATION] Temporary passwords saved to {LEGACY_CREDENTIALS_FILE}")
    print("=" * 55 + "\n", flush=True)
    return len(credentials)


@app.cli.command("import-json")
def import_json_command():
    """flask --app app import-json : import wallet_data.json into an empty DB."""
    if User.query.first():
        print("Database already has users; refusing to import twice.")
        return
    import_legacy_json()


def init_db() -> None:
    with app.app_context():
        db.create_all()
        if not User.query.first() and os.path.exists(LEGACY_JSON_FILE):
            import_legacy_json()


init_db()

if __name__ == "__main__":
    app.run(debug=True, port=5000)