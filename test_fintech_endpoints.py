import json
import sys

# Ensure UTF-8 output on Windows terminal
if sys.platform == "win32":
    sys.stdout.reconfigure(encoding="utf-8")

from app import app, db, User, Wallet, Reward, Notification, Transaction

client = app.test_client()

def test_tier1_fintech_flows():
    print("--- 1. Authenticating as Priyanshu Chauhan (Founder Demo) ---")
    login_res = client.post("/api/login", json={
        "username": "priyanshu",
        "password": "Nova@123"
    })
    assert login_res.status_code == 200, f"Login failed: {login_res.data}"
    token = login_res.json.get("access_token") or login_res.json.get("token")
    headers = {"Authorization": f"Bearer {token}"}
    print(" Login successful, JWT acquired.")

    print("\n--- 2. Validating User & Wallet Metadata (/api/me) ---")
    me_res = client.get("/api/me", headers=headers)
    assert me_res.status_code == 200
    me_data = me_res.json["data"]
    assert me_data["username"] == "priyanshu"
    wallet = me_data["wallet"]
    assert "card_frozen" in wallet
    assert "daily_limit_inr" in wallet
    assert "primary_bank" in wallet
    print(f" Wallet verified. Balance: ₹{me_data['wallet_balance']}, Primary Bank: {wallet['primary_bank']}")

    print("\n--- 3. Testing CRED Mystery Scratch Cards (/api/rewards) ---")
    rewards_res = client.get("/api/rewards", headers=headers)
    assert rewards_res.status_code == 200
    rewards = rewards_res.json["rewards"]
    assert len(rewards) >= 1
    unclaimed = [r for r in rewards if not r["claimed"]]
    print(f" Found {len(rewards)} total rewards, {len(unclaimed)} unclaimed.")

    if unclaimed:
        target_id = unclaimed[0]["id"]
        pre_bal = me_data["wallet_balance"]
        claim_res = client.post("/api/rewards/claim", headers=headers, json={"reward_id": target_id})
        assert claim_res.status_code == 200
        assert claim_res.json["claimed"] is True
        new_bal = claim_res.json["new_balance"]
        assert new_bal > pre_bal
        print(f" Scratch card claimed! Cashback: ₹{claim_res.json['cashback']}, New Balance: ₹{new_bal}")

    print("\n--- 4. Testing BBPS Utility BillPay Engine (/api/bills/fetch & pay) ---")
    fetch_res = client.post("/api/bills/fetch", headers=headers, json={
        "category": "electricity",
        "consumer_id": "102938475"
    })
    assert fetch_res.status_code == 200
    bill = fetch_res.json["bill"]
    assert bill["biller"] == "Tata Power Delhi Distribution Ltd"
    bill_id = bill["bill_id"]
    print(f" Bill fetched: {bill['biller']} | Due: ₹{bill['amount']} for {bill['consumer_name']}")

    # Pay bill with default demo MPIN 1234
    pay_res = client.post("/api/bills/pay", headers=headers, json={
        "bill_id": bill_id,
        "mpin": "1234"
    })
    assert pay_res.status_code == 200
    assert pay_res.json["status"] == "success"
    print(f" Bill paid successfully! Txn ID: {pay_res.json['txn_id']}")
    if "reward" in pay_res.json:
        print(f"   Reward generated: {pay_res.json['reward']['title']}")

    print("\n--- 5. Testing Jupiter / RazorpayX Titanium Card Controls ---")
    # Freeze toggle
    freeze_res = client.post("/api/card/freeze", headers=headers)
    assert freeze_res.status_code == 200
    assert freeze_res.json["frozen"] is True
    print(" Card successfully frozen.")

    unfreeze_res = client.post("/api/card/freeze", headers=headers)
    assert unfreeze_res.status_code == 200
    assert unfreeze_res.json["frozen"] is False
    print(" Card successfully unfrozen.")

    # Reveal PAN & CVV
    reveal_res = client.post("/api/card/reveal", headers=headers)
    assert reveal_res.status_code == 200
    assert "card_number" in reveal_res.json
    assert "cvv" in reveal_res.json
    assert reveal_res.json["cvv"] == "481"
    print(f" Card credentials revealed: {reveal_res.json['card_number']} (CVV: {reveal_res.json['cvv']})")

    # Limit update
    limit_res = client.post("/api/card/limit", headers=headers, json={"limit_inr": 85000})
    assert limit_res.status_code == 200
    assert limit_res.json["limit_inr"] == 85000
    print(f" Daily limit updated: ₹{limit_res.json['limit_inr']}")

    # Test daily cap boundary enforcement
    tight_limit = client.post("/api/card/limit", headers=headers, json={"limit_inr": 5000})
    assert tight_limit.status_code == 200
    over_limit_bill = client.post("/api/bills/pay", headers=headers, json={
        "category": "Electricity",
        "operator": "Tata Power",
        "consumer_id": "999888",
        "amount": 7500.00,
        "mpin": "1234"
    })
    assert over_limit_bill.status_code == 400
    err_msg = over_limit_bill.json.get("msg") or over_limit_bill.json.get("error", "")
    assert "daily spend cap" in err_msg.lower()
    print(" Daily spend cap successfully rejected over-limit transaction.")

    # Reset limit back to healthy ₹1,00,000
    reset_lim = client.post("/api/card/limit", headers=headers, json={"limit_inr": 100000})
    assert reset_lim.status_code == 200

    # Switch bank instrument
    bank_res = client.post("/api/card/switch_bank", headers=headers)
    assert bank_res.status_code == 200
    print(f" Primary linked bank switched to: {bank_res.json['primary_bank']}")

    print("\n--- 6. Testing Notifications Bell & Feed ---")
    notif_res = client.get("/api/notifications", headers=headers)
    assert notif_res.status_code == 200
    assert len(notif_res.json["notifications"]) >= 1
    print(f" Notifications retrieved: {len(notif_res.json['notifications'])} items (Unread: {notif_res.json['unread_count']})")

    read_res = client.post("/api/notifications/read", headers=headers)
    assert read_res.status_code == 200
    print(" All notifications marked as read.")

    print("\n--- 7. Testing Real-Time Sync Endpoint (/api/sync) ---")
    sync_res = client.get("/api/sync", headers=headers)
    assert sync_res.status_code == 200
    sync_data = sync_res.json["wallet"]
    assert "wallet_balance" in sync_data
    assert "unread_notifications" in sync_data
    print(f" Sync verified: Balance ₹{sync_data['wallet_balance']}, Unread notifs: {sync_data['unread_notifications']}")

    print("\n--- 8. Strict Verification: Zero Stale Names ---")
    forbidden = ["prakhar", "bikash", "rahul", "deepti", "peer a", "peer b"]
    with app.app_context():
        users = [u.username.lower() for u in User.query.all()]
        for f_name in forbidden:
            assert f_name not in users, f"Found purged name {f_name} in User table!"

        txns = Transaction.query.all()
        for t in txns:
            content = f"{t.note or ''} {t.category or ''}".lower()
            for f_name in forbidden:
                assert f_name not in content, f"Found purged name {f_name} in Transaction ID {t.txn_id}!"
    print(" ZERO purged names found in database tables!")

    print("\n=======================================================")
    print("ALL TIER-1 FINTECH TESTS PASSED WITH 100% SUCCESS!")
    print("=======================================================")

if __name__ == "__main__":
    test_tier1_fintech_flows()
