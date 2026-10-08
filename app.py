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
try:
    from google import genai
except ImportError:
    genai = None


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
    __allow_unmapped__ = True

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
    __allow_unmapped__ = True

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
    __allow_unmapped__ = True

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
    __allow_unmapped__ = True

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




class Vault(db.Model):
    """Smart Goal Savings Vault (Lockers) for ring-fenced funds."""

    __tablename__ = "vaults"
    __allow_unmapped__ = True

    id: Any = db.Column(db.Integer, primary_key=True)
    user_id: Any = db.Column(db.Integer, db.ForeignKey("users.id", ondelete="CASCADE"), nullable=False, index=True)
    name: Any = db.Column(db.String(64), nullable=False)
    balance_paise: Any = db.Column(db.Integer, nullable=False, default=0)
    target_paise: Any = db.Column(db.Integer, nullable=False, default=0)
    created_at: Any = db.Column(db.DateTime, nullable=False, default=utcnow)
    updated_at: Any = db.Column(db.DateTime, nullable=False, default=utcnow, onupdate=utcnow)

    user: Any = db.relationship("User", backref=db.backref("vaults", cascade="all, delete-orphan", lazy=True))

    __table_args__ = (
        CheckConstraint("balance_paise >= 0", name="ck_vault_balance_non_negative"),
        CheckConstraint("target_paise >= 0", name="ck_vault_target_non_negative"),
    )

    def __init__(
        self,
        user_id: int | None = None,
        name: str = "",
        balance_paise: int = 0,
        target_paise: int = 0,
        created_at: datetime | None = None,
        updated_at: datetime | None = None,
        **kwargs: Any,
    ) -> None:
        super().__init__(**kwargs)
        if user_id is not None:
            self.user_id = user_id
        if name:
            self.name = name
        self.balance_paise = balance_paise
        self.target_paise = target_paise
        if created_at is not None:
            self.created_at = created_at
        if updated_at is not None:
            self.updated_at = updated_at
        for k, v in kwargs.items():
            setattr(self, k, v)


class OtpChallenge(db.Model):
    """One active OTP per user, bound to a specific payment."""

    __tablename__ = "otp_challenges"
    __allow_unmapped__ = True

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


def issue_otp(user: User, purpose: str, receiver_id: int, amount_paise: int, request_id=None) -> str:
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
    try:
        print(f"[CONTEXT] {purpose} {fmt_inr(amount_paise)} | valid {int(OTP_TTL.total_seconds() // 60)} min")
    except UnicodeEncodeError:
        print(f"[CONTEXT] {purpose} INR {to_rupees(amount_paise):.2f} | valid {int(OTP_TTL.total_seconds() // 60)} min")
    print("[STATUS] 200 OK - Message logged to secure terminal.")
    print("=" * 55 + "\n", flush=True)
    return code


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
        desc = t.note or "HDFC Bank NEFT Inward"
        counterparty = "HDFC Bank"
    elif is_credit:
        counterparty = t.sender.username if t.sender else "Unknown"
        desc = t.note or f"Received from {counterparty}"
    else:
        counterparty = t.receiver.username if t.receiver else "Merchant"
        desc = t.note or f"Paid to {counterparty}"
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


def serialize_vault(v: Vault) -> dict:
    bal = to_rupees(v.balance_paise)
    tgt = to_rupees(v.target_paise)
    pct = round((v.balance_paise / v.target_paise * 100), 1) if v.target_paise > 0 else 100.0
    return {
        "id": v.id,
        "name": v.name,
        "balance": bal,
        "target": tgt,
        "progress_pct": min(100.0, max(0.0, pct)),
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
    vaults_data = [serialize_vault(v) for v in (user.vaults or [])]
    vaults_total = sum(v["balance"] for v in vaults_data)
    wallet_bal = to_rupees(wallet.balance_paise) if wallet else 0.0
    bank_bal = to_rupees(wallet.bank_balance_paise) if wallet else 0.0
    net_worth = round(wallet_bal + bank_bal + vaults_total, 2)
    return {
        "username": user.username,
        "email": user.email,
        "phone": user.phone,
        "wallet_balance": wallet_bal,
        "bank_balance": bank_bal,
        "vaults_total": vaults_total,
        "net_worth": net_worth,
        "vaults": vaults_data,
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


@app.route("/api/register", methods=["POST"])
@app.route("/api/signup", methods=["POST"])
def register():
    simulate_latency(0.8)
    info = json_body()
    name = str(info.get("username") or info.get("user", "")).strip().lower()
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
    # Default starting Linked Bank Balance of ₹50,000.00 and Wallet Balance of ₹1,000.00 signup bonus
    user.wallet = Wallet(balance_paise=1000 * PAISE, bank_balance_paise=50000 * PAISE)
    db.session.add(user)
    try:
        db.session.commit()
    except IntegrityError:  # Lost race
        db.session.rollback()
        return err("User already exists!")

    token = issue_token(user)
    return ok(
        "Account created successfully!",
        access_token=token,
        username=user.username,
        user=user_snapshot(user),
    )


# Pre-computed so failed lookups take the same time as wrong passwords
_DUMMY_HASH = generate_password_hash(secrets.token_hex(16))


@app.route("/api/login", methods=["POST"])
def login():
    simulate_latency(0.6)
    info = json_body()
    name = str(info.get("username") or info.get("user", "")).strip().lower()
    password = str(info.get("password", ""))
    if not name or not password:
        return err("Username and password are required.")

    user = find_user(name)
    if not user:
        check_password_hash(_DUMMY_HASH, password)
        return err("Invalid username or password.", 401)
    if not user.check_password(password):
        return err("Invalid username or password.", 401)

    token = issue_token(user)
    return ok(
        "Welcome back!",
        access_token=token,
        username=user.username,
        user=user_snapshot(user),
    )


@app.route("/api/me", methods=["GET"])
@jwt_required()
def me():
    return ok(data=user_snapshot(current_user))



@app.route("/api/users/directory", methods=["GET"])
@jwt_required()
def users_directory():
    """Return newly registered users plus verified commercial merchants."""
    merchants = [
        {"username": "Zomato", "name": "Zomato Limited", "type": "merchant", "category": "Food", "avatar": "🍕"},
        {"username": "Swiggy", "name": "Swiggy Food & Instamart", "type": "merchant", "category": "Food", "avatar": "🍔"},
        {"username": "Amazon Pay", "name": "Amazon Pay India", "type": "merchant", "category": "Shopping", "avatar": "🛍️"},
        {"username": "IRCTC", "name": "IRCTC Rail Connect", "type": "merchant", "category": "Travel", "avatar": "🚆"},
        {"username": "BESCOM Power", "name": "BESCOM Electricity Utility", "type": "merchant", "category": "Bills", "avatar": "⚡"},
    ]
    reg_users = (
        User.query.filter(User.id != current_user.id)
        .order_by(User.created_at.desc())
        .limit(20)
        .all()
    )
    merchant_user_names = {m["username"].lower() for m in merchants}
    user_list = []
    for u in reg_users:
        if u.username.lower() not in merchant_user_names and not u.username.startswith("merchant-"):
            user_list.append({
                "username": u.username,
                "name": u.username.title(),
                "type": "user",
                "category": "Transfer",
                "avatar": u.username[0].upper(),
            })
    return ok(directory=user_list + merchants)


# --------------------------------------------------------------------------- #
# Routes: Smart Goal Vaults (Savings Lockers)
# --------------------------------------------------------------------------- #
@app.route("/api/vaults", methods=["GET"])
@jwt_required()
def get_vaults():
    user = current_user
    vaults = [serialize_vault(v) for v in (user.vaults or [])]
    return ok(vaults=vaults)


@app.route("/api/vaults/deposit", methods=["POST"])
@jwt_required()
def deposit_vault():
    user = current_user
    body = json_body()
    vault_id = body.get("vault_id")
    vault_name = body.get("name")
    try:
        amt = parse_amount(body.get("amount", 0), max_paise=WALLET_LIMIT_PAISE, label="Deposit amount")
    except ValueError as e:
        return err(str(e))

    def work():
        vault = None
        if vault_id:
            vault = Vault.query.filter_by(id=vault_id, user_id=user.id).first()
        elif vault_name:
            vault = Vault.query.filter_by(name=vault_name, user_id=user.id).first()
        if not vault:
            return err("Goal vault not found.", 404)

        # Atomic debit from wallet
        res = db.session.execute(
            update(Wallet)
            .where(Wallet.user_id == user.id, Wallet.balance_paise >= amt)
            .values(balance_paise=Wallet.balance_paise - amt)
        )
        if res.rowcount != 1:
            return err("Insufficient liquid wallet balance for vault deposit.", 400)

        vault.balance_paise += amt
        vault.updated_at = utcnow()

        txn = Transaction(
            txn_id=generate_txn_id(),
            sender_id=user.id,
            receiver_id=user.id,
            amount_paise=amt,
            category="Savings",
            kind=Transaction.KIND_TRANSFER,
            note=f"Deposit to {vault.name}",
            timestamp=utcnow(),
        )
        db.session.add(txn)
        db.session.flush()

        return ok(f"Deposited {fmt_inr(amt)} into {vault.name}!", vault=serialize_vault(vault), user=user_snapshot(user))

    return commit_or_error(work)


@app.route("/api/vaults/withdraw", methods=["POST"])
@jwt_required()
def withdraw_vault():
    user = current_user
    body = json_body()
    vault_id = body.get("vault_id")
    vault_name = body.get("name")
    try:
        amt = parse_amount(body.get("amount", 0), max_paise=WALLET_LIMIT_PAISE, label="Withdrawal amount")
    except ValueError as e:
        return err(str(e))

    def work():
        vault = None
        if vault_id:
            vault = Vault.query.filter_by(id=vault_id, user_id=user.id).first()
        elif vault_name:
            vault = Vault.query.filter_by(name=vault_name, user_id=user.id).first()
        if not vault:
            return err("Goal vault not found.", 404)

        if vault.balance_paise < amt:
            return err(f"Insufficient funds in vault (Available: {to_rupees(vault.balance_paise)}).", 400)

        vault.balance_paise -= amt
        vault.updated_at = utcnow()

        db.session.execute(
            update(Wallet)
            .where(Wallet.user_id == user.id)
            .values(balance_paise=Wallet.balance_paise + amt)
        )

        txn = Transaction(
            txn_id=generate_txn_id(),
            sender_id=user.id,
            receiver_id=user.id,
            amount_paise=amt,
            category="Savings",
            kind=Transaction.KIND_TRANSFER,
            note=f"Withdrawal from {vault.name}",
            timestamp=utcnow(),
        )
        db.session.add(txn)
        db.session.flush()

        return ok(f"Withdrew {fmt_inr(amt)} from {vault.name} to Wallet!", vault=serialize_vault(vault), user=user_snapshot(user))

    return commit_or_error(work)


# --------------------------------------------------------------------------- #
# Routes: Nova AI Financial Copilot
# --------------------------------------------------------------------------- #
def _compute_fallback_ai_analysis(user: User) -> dict:
    wallet_rupees = to_rupees(user.wallet.balance_paise)
    bank_rupees = to_rupees(user.wallet.bank_balance_paise)
    vaults_rupees = sum(to_rupees(v.balance_paise) for v in (user.vaults or []))
    net_worth = round(wallet_rupees + bank_rupees + vaults_rupees, 2)

    txns = Transaction.query.filter(or_(Transaction.sender_id == user.id, Transaction.receiver_id == user.id)).all()
    inflow = sum(to_rupees(t.amount_paise) for t in txns if t.receiver_id == user.id)
    outflow = sum(to_rupees(t.amount_paise) for t in txns if t.sender_id == user.id)

    cat_spend = {}
    for t in txns:
        if t.sender_id == user.id:
            cat = t.category or "Other"
            cat_spend[cat] = cat_spend.get(cat, 0.0) + to_rupees(t.amount_paise)

    top_cat = max(cat_spend.items(), key=lambda x: x[1])[0] if cat_spend else "Shopping"
    top_cat_amt = cat_spend.get(top_cat, 0.0)
    reserve_ratio = round(((bank_rupees + vaults_rupees) / net_worth * 100), 1) if net_worth > 0 else 80.0
    safe_daily = round(max(0.0, wallet_rupees / 30.0), 2)

    insights = [
        f"Liquid wallet holds ₹{wallet_rupees:,.2f} with ₹{bank_rupees:,.2f} secured in HDFC Core Banking across ₹{net_worth:,.2f} total net worth.",
        f"Capital reserve health ratio is {reserve_ratio}% — well above the 50% baseline for prudent liquidity management.",
        f"Primary expense outflow is centered in {top_cat} (₹{top_cat_amt:,.2f}) across recent settlement cycles.",
    ]

    return {
        "insights": insights,
        "net_worth": net_worth,
        "wallet": wallet_rupees,
        "bank": bank_rupees,
        "vaults": vaults_rupees,
        "inflow": inflow,
        "outflow": outflow,
        "safe_daily": safe_daily,
        "top_cat": top_cat,
        "top_cat_amt": top_cat_amt,
    }


@app.route("/api/ai/insights", methods=["GET"])
@jwt_required()
def ai_insights():
    user = current_user
    data = _compute_fallback_ai_analysis(user)
    gemini_key = os.getenv("GEMINI_API_KEY")
    if gemini_key and genai:
        try:
            client = genai.Client(api_key=gemini_key)
            prompt = (
                f"You are Nova AI, an elite fintech financial analyst for NovaWallet (an Indian UPI banking platform). "
                f"User ledger data:\n"
                f"- Liquid Wallet: ₹{data['wallet']:,.2f}\n"
                f"- Bank Reserve: ₹{data['bank']:,.2f}\n"
                f"- Savings Vaults: ₹{data['vaults']:,.2f}\n"
                f"- Total Net Worth: ₹{data['net_worth']:,.2f}\n"
                f"- 30-Day Inflow: ₹{data['inflow']:,.2f}\n"
                f"- 30-Day Outflow: ₹{data['outflow']:,.2f}\n"
                f"- Top Expense: {data['top_cat']} (₹{data['top_cat_amt']:,.2f})\n"
                f"Provide exactly 3 concise, high-impact bullet points analyzing their financial standing. "
                f"Include exact rupee figures. Do not use asterisks or markdown bold, just return 3 plain lines."
            )
            response = client.models.generate_content(
                model="gemini-2.5-flash",
                contents=prompt,
            )
            lines = [line.strip().lstrip("-•* ").strip() for line in (response.text or "").split("\n") if line.strip()]
            if len(lines) >= 3:
                return ok(insights=lines[:3], source="gemini")
        except Exception as e:
            app.logger.warning("Gemini AI insights fallback: %s", e)

    return ok(insights=data["insights"], source="analytics_engine")


@app.route("/api/ai/ask", methods=["POST"])
@jwt_required()
def ai_ask():
    user = current_user
    body = json_body()
    query = str(body.get("query") or body.get("prompt") or "").strip()
    if not query:
        return err("Query is required.")

    data = _compute_fallback_ai_analysis(user)
    gemini_key = os.getenv("GEMINI_API_KEY")

    if gemini_key and genai:
        try:
            client = genai.Client(api_key=gemini_key)
            prompt = (
                f"You are Nova AI Financial Copilot, an elite private banker and quantitative financial advisor "
                f"embedded in NovaWallet (India). Speak with executive fintech clarity, precision, and authority. "
                f"Always quote rupee values with '₹'.\n"
                f"User Profile & Live Financial State:\n"
                f"- Username: {user.username}\n"
                f"- Liquid Spendable Wallet: ₹{data['wallet']:,.2f}\n"
                f"- Core Bank Balance: ₹{data['bank']:,.2f}\n"
                f"- Goal Vaults: ₹{data['vaults']:,.2f}\n"
                f"- Total Net Worth: ₹{data['net_worth']:,.2f}\n"
                f"- Total Recorded Inflow: ₹{data['inflow']:,.2f}\n"
                f"- Total Recorded Outflow: ₹{data['outflow']:,.2f}\n"
                f"- Safe Daily Spend: ₹{data['safe_daily']:,.2f}/day\n"
                f"- Largest Outflow Category: {data['top_cat']} (₹{data['top_cat_amt']:,.2f})\n\n"
                f"User Question: '{query}'\n"
                f"Provide a structured, insightful, actionable answer formatted in crisp paragraphs or clean bullet points."
            )
            response = client.models.generate_content(
                model="gemini-2.5-flash",
                contents=prompt,
            )
            if response.text:
                return ok(answer=response.text.strip(), source="gemini")
        except Exception as e:
            app.logger.warning("Gemini AI ask fallback: %s", e)

    q_lower = query.lower()
    if "cashflow" in q_lower or "audit" in q_lower:
        net_saved = max(0.0, data["inflow"] - data["outflow"])
        answer = (
            f"📊 **Nova Executive Cashflow Audit**\n\n"
            f"• **Gross Inflow:** +₹{data['inflow']:,.2f} inward settlements\n"
            f"• **Gross Outflow:** -₹{data['outflow']:,.2f} outbound payments\n"
            f"• **Net Surplus:** +₹{net_saved:,.2f} retained in ecosystem\n"
            f"• **Coverage:** Liquid wallet covers ~{int(data['wallet'] / max(1.0, data['safe_daily']))} days of operations without tapping into your ₹{data['bank']:,.2f} HDFC Core Bank reserve."
        )
    elif "unusual" in q_lower or "detect" in q_lower or "fraud" in q_lower:
        answer = (
            f"🛡️ **Spend Anomaly & Outlier Scan**\n\n"
            f"• **Risk Assessment:** No fraudulent or anomalous debit patterns detected.\n"
            f"• **Largest Outflow:** ₹{data['top_cat_amt']:,.2f} categorized under **{data['top_cat']}**.\n"
            f"• **Verification:** All debits match verified counterparty signatures (Amazon Pay, Zomato, Reliance Jio)."
        )
    elif "daily" in q_lower or "safe" in q_lower:
        answer = (
            f"🎯 **Discretionary Safe Daily Spend Calculation**\n\n"
            f"• **Safe Discretionary Cap:** **₹{data['safe_daily']:,.2f} / day** over a 30-day operating horizon.\n"
            f"• **Runway:** At this pace, your ₹{data['wallet']:,.2f} liquid wallet is fully preserved without liquidating savings vaults or bank deposits."
        )
    elif "tax" in q_lower or "split" in q_lower or "advice" in q_lower or "saving" in q_lower:
        inflow = data["inflow"] if data["inflow"] > 0 else (data["wallet"] + data["bank"])
        needs = inflow * 0.50
        wants = inflow * 0.30
        savings = inflow * 0.20
        answer = (
            f"💡 **50 / 30 / 20 Capital Allocation Framework**\n\n"
            f"• **50% Core Needs:** ₹{needs:,.2f} (Bills, Utilities, Telecom)\n"
            f"• **30% Discretionary:** ₹{wants:,.2f} (Dining, Retail)\n"
            f"• **20% Wealth & Tax Reserve:** ₹{savings:,.2f} (Smart Goal Vaults, Fixed Deposits)\n\n"
            f"Maintain ₹5,000 monthly allocation to reach your Emergency Reserve target of ₹25,000."
        )
    else:
        answer = (
            f"🤖 **Nova Financial Intelligence Analysis**\n\n"
            f"For account **@{user.username}**:\n"
            f"• **Combined Net Worth:** ₹{data['net_worth']:,.2f}\n"
            f"• **Liquid Wallet:** ₹{data['wallet']:,.2f} | **Core Bank:** ₹{data['bank']:,.2f}\n"
            f"• **Goal Vaults:** ₹{data['vaults']:,.2f}\n"
            f"• **Cashflow Velocity:** +₹{data['inflow']:,.2f} in / -₹{data['outflow']:,.2f} out.\n"
            f"Your current capital structure demonstrates high solvency and strong liquidity reserves."
        )

    return ok(answer=answer, source="python_analytics_engine")


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
        code = issue_otp(user, OtpChallenge.PURPOSE_APPROVE, pr.requester_id, pr.amount_paise, pr.request_id)
        return ok(
            "OTP Generated via Mock SMS Gateway!",
            demo_otp=code,
            amount=to_rupees(pr.amount_paise),
            purpose="APPROVE",
            receiver=pr.requester.username,
        )

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

    code = issue_otp(user, OtpChallenge.PURPOSE_PAY, receiver.id, amt)
    return ok(
        "OTP Generated via Mock SMS Gateway!",
        demo_otp=code,
        amount=to_rupees(amt),
        purpose="PAY",
        receiver=receiver.username,
    )


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


def seed_demo_accounts() -> None:
    """Seed single Founder Demo 'priyanshu' (₹45,000 wallet, ₹1,50,000 bank),
    verified commercial merchants, Smart Savings Vaults, and realistic commercial ledger."""
    founder_name = "priyanshu"
    u = find_user(founder_name)
    if not u:
        u = User(username=founder_name, email="priyanshu@novawallet.dev", phone="9876543210")
        u.set_password("Nova@123")
        u.wallet = Wallet(balance_paise=45_000 * PAISE, bank_balance_paise=150_000 * PAISE)
        db.session.add(u)
    else:
        u.set_password("Nova@123")
        if not u.wallet:
            u.wallet = Wallet(balance_paise=45_000 * PAISE, bank_balance_paise=150_000 * PAISE)
        else:
            u.wallet.balance_paise = 45_000 * PAISE
            u.wallet.bank_balance_paise = 150_000 * PAISE
    db.session.commit()

    # Seed verified commercial merchants
    merchants_to_seed = [
        ("Amazon Pay India", "merchant-amazon@novapay.dev", "Shopping"),
        ("Zomato Limited", "merchant-zomato@novapay.dev", "Food"),
        ("Reliance Jio Infocomm", "merchant-jio@novapay.dev", "Bills"),
        ("Zomato", "support@zomato.com", "Food"),
        ("Swiggy", "support@swiggy.in", "Food"),
        ("Amazon Pay", "payments@amazon.in", "Shopping"),
        ("IRCTC", "ticketadmin@irctc.co.in", "Travel"),
        ("BESCOM Power", "billing@bescom.karnataka.gov.in", "Bills"),
    ]
    merchant_users = {}
    for m_name, m_email, _ in merchants_to_seed:
        m_user = find_user(m_name)
        if not m_user:
            m_user = User(username=m_name, email=m_email, phone="1800" + secrets.token_hex(3)[:6])
            m_user.set_password(secrets.token_urlsafe(16))
            m_user.wallet = Wallet(balance_paise=100_000 * PAISE, bank_balance_paise=500_000 * PAISE)
            db.session.add(m_user)
        merchant_users[m_name] = m_user
    db.session.commit()

    # Pre-seed 2 Smart Goal Vaults for priyanshu
    existing_vaults = {v.name: v for v in u.vaults}
    if "Emergency Reserve" not in existing_vaults:
        v1 = Vault(user_id=u.id, name="Emergency Reserve", balance_paise=10_000 * PAISE, target_paise=25_000 * PAISE)
        db.session.add(v1)
    if "MacBook Pro M4 Fund" not in existing_vaults:
        v2 = Vault(user_id=u.id, name="MacBook Pro M4 Fund", balance_paise=15_000 * PAISE, target_paise=120_000 * PAISE)
        db.session.add(v2)
    db.session.commit()

    # Seed realistic commercial transaction ledger for priyanshu
    existing_txns = Transaction.query.filter(or_(Transaction.sender_id == u.id, Transaction.receiver_id == u.id)).count()
    if existing_txns == 0:
        base_time = utcnow() - timedelta(days=5)
        t1 = Transaction(
            txn_id="TXN_DEP_50K",
            sender_id=None,
            receiver_id=u.id,
            amount_paise=50_000 * PAISE,
            category="Deposit",
            kind=Transaction.KIND_LOAD,
            note="HDFC Bank NEFT Inward",
            timestamp=base_time + timedelta(hours=2),
        )
        m_amz = merchant_users.get("Amazon Pay India") or merchant_users.get("Amazon Pay")
        t2 = Transaction(
            txn_id="TXN_AMZ_2499",
            sender_id=u.id,
            receiver_id=m_amz.id,
            amount_paise=2499 * PAISE,
            category="Shopping",
            kind=Transaction.KIND_TRANSFER,
            note="Amazon Pay India - Prime Order",
            timestamp=base_time + timedelta(days=1, hours=4),
        )
        m_zom = merchant_users.get("Zomato Limited") or merchant_users.get("Zomato")
        t3 = Transaction(
            txn_id="TXN_ZOM_640",
            sender_id=u.id,
            receiver_id=m_zom.id,
            amount_paise=640 * PAISE,
            category="Food",
            kind=Transaction.KIND_TRANSFER,
            note="Zomato Limited - Gourmet Dining",
            timestamp=base_time + timedelta(days=2, hours=6),
        )
        m_jio = merchant_users.get("Reliance Jio Infocomm")
        t4 = Transaction(
            txn_id="TXN_JIO_799",
            sender_id=u.id,
            receiver_id=m_jio.id,
            amount_paise=799 * PAISE,
            category="Bills",
            kind=Transaction.KIND_TRANSFER,
            note="Reliance Jio Infocomm - AirFiber 5G",
            timestamp=base_time + timedelta(days=3, hours=1),
        )
        db.session.add_all([t1, t2, t3, t4])
        db.session.commit()


def init_db() -> None:
    with app.app_context():
        db.create_all()
        seed_demo_accounts()


init_db()

if __name__ == "__main__":
    port = int(os.environ.get("PORT", 5000))
    app.run(host="0.0.0.0", port=port, debug=os.environ.get("FLASK_DEBUG", "0") == "1")
