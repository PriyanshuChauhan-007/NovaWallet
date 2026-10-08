import sys
sys.stdout.reconfigure(encoding="utf-8")
import json
from app import app, db, User, Wallet

def test_auth_and_features():
    client = app.test_client()

    with app.app_context():
        old = User.query.filter_by(username="testuser1").first()
        if old:
            db.session.delete(old)
            db.session.commit()

    print("[TEST 1] Registering testuser1...")
    res = client.post("/api/register", json={
        "username": "TestUser1 ",
        "email": "testuser1@novawallet.dev",
        "phone": "9876543299",
        "password": "Password@123"
    })
    assert res.status_code == 200, f"Register failed: {res.data}"
    reg_data = res.get_json()
    assert reg_data["status"] == "success"
    assert "access_token" in reg_data, "No access token in registration response!"
    assert reg_data["username"] == "testuser1", f"Username was not normalized: {reg_data['username']}"
    token = reg_data["access_token"]
    user_data = reg_data["user"]
    print(f" -> Successfully registered testuser1. Token: {token[:20]}...")
    print(f" -> Wallet: {user_data['wallet_balance']}, Bank: {user_data['bank_balance']}")
    assert user_data["wallet_balance"] == 1000.0, f"Expected 1000.0, got {user_data['wallet_balance']}"
    assert user_data["bank_balance"] == 50000.0, f"Expected 50000.0, got {user_data['bank_balance']}"

    print("[TEST 2] Accessing /api/me with registration token...")
    res_me = client.get("/api/me", headers={"Authorization": f"Bearer {token}"})
    assert res_me.status_code == 200, f"Me failed: {res_me.data}"
    me_data = res_me.get_json()
    assert me_data["data"]["username"] == "testuser1"
    print(" -> /api/me authenticated successfully!")

    print("[TEST 3] Logging out (discarding token) and logging back in with testuser1...")
    res_login = client.post("/api/login", json={
        "username": "  TESTUSER1  ",
        "password": "Password@123"
    })
    assert res_login.status_code == 200, f"Login failed: {res_login.data}"
    login_data = res_login.get_json()
    assert login_data["status"] == "success"
    assert "access_token" in login_data
    login_token = login_data["access_token"]
    print(f" -> Logged back in with testuser1! New Token: {login_token[:20]}...")

    print("[TEST 4] Founder Demo login priyanshu...")
    res_founder = client.post("/api/login", json={
        "username": "Priyanshu",
        "password": "Nova@123"
    })
    assert res_founder.status_code == 200
    founder_data = res_founder.get_json()
    f_user = founder_data["user"]
    assert f_user["wallet_balance"] == 45000.0, f"Expected 45000.0, got {f_user['wallet_balance']}"
    assert f_user["bank_balance"] == 150000.0, f"Expected 150000.0, got {f_user['bank_balance']}"
    assert f_user["net_worth"] == 220000.0, f"Expected 220000.0, got {f_user['net_worth']}"
    print(f" -> Founder Demo login verified! Net Worth: {f_user['net_worth']}")

    print("[TEST 5] Directory endpoint...")
    f_token = founder_data["access_token"]
    res_dir = client.get("/api/users/directory", headers={"Authorization": f"Bearer {f_token}"})
    assert res_dir.status_code == 200
    dir_data = res_dir.get_json()["directory"]
    dir_usernames = [d["username"] for d in dir_data]
    print(f" -> Directory usernames: {dir_usernames}")
    assert "testuser1" in dir_usernames
    assert "Zomato" in dir_usernames
    assert "Amazon Pay" in dir_usernames

    print("[TEST 6] Vault deposit & withdraw...")
    res_vaults = client.get("/api/vaults", headers={"Authorization": f"Bearer {f_token}"})
    assert res_vaults.status_code == 200
    vaults = res_vaults.get_json()["vaults"]
    assert len(vaults) == 2
    v1_id = vaults[0]["id"]
    res_dep = client.post("/api/vaults/deposit", json={"vault_id": v1_id, "amount": 1000}, headers={"Authorization": f"Bearer {f_token}"})
    assert res_dep.status_code == 200
    res_with = client.post("/api/vaults/withdraw", json={"vault_id": v1_id, "amount": 1000}, headers={"Authorization": f"Bearer {f_token}"})
    assert res_with.status_code == 200
    print(" -> Vault deposit & withdraw executed cleanly!")

    print("[TEST 7] AI Insights & Ask endpoints...")
    res_ins = client.get("/api/ai/insights", headers={"Authorization": f"Bearer {f_token}"})
    assert res_ins.status_code == 200
    ins_data = res_ins.get_json()
    assert len(ins_data["insights"]) == 3
    print(" -> AI Insights (3 points):")
    for pt in ins_data["insights"]:
        print(f"     * {pt}")

    res_ask = client.post("/api/ai/ask", json={"query": "Full Cashflow Audit"}, headers={"Authorization": f"Bearer {f_token}"})
    assert res_ask.status_code == 200
    print(" -> AI Ask returned successfully!")

    print("\nALL AUTOMATED BACKEND TESTS PASSED WITH 0 ERRORS!")

if __name__ == "__main__":
    test_auth_and_features()
