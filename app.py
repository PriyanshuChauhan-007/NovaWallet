from flask import Flask, request, jsonify, send_file
from flask_cors import CORS
from datetime import datetime
import json
import os
import random
import string
import time  # Added for simulated network latency

app = Flask(__name__)
CORS(app) 

DATA_FILE = "wallet_data.json" 
pending_otps = {}

def get_db():
    if not os.path.exists(DATA_FILE):
        return {}
    with open(DATA_FILE, "r") as f:
        return json.load(f)

def save_db(data):
    with open(DATA_FILE, "w") as f:
        json.dump(data, f, indent=4)

def generate_txn_id():
    return 'TXN-' + ''.join(random.choices(string.ascii_uppercase + string.digits, k=8))

@app.route('/')
def index():
    return send_file('index.html')

@app.route('/api/signup', methods=['POST'])
def signup():
    time.sleep(0.8) # Simulating network latency
    info = request.json
    name = info.get("user", "").strip()
    email = info.get("email", "").strip()
    phone = info.get("phone", "").strip()
    
    if not name:
        return jsonify({"msg": "Username missing!", "status": "error"}), 400
    if not email or not phone:
        return jsonify({"msg": "Email and Phone are required for signup!", "status": "error"}), 400
        
    db = get_db()
    if name in db:
        return jsonify({"msg": "User already exists!", "status": "error"}), 400
    
    db[name] = {
        "email": email,
        "phone": phone,
        "wallet_balance": 0.0, 
        "bank_balance": 50000.0, 
        "history": [],
        "stats": {"in": 0.0, "out": 0.0}
    }
    save_db(db)
    return jsonify({"msg": "Wallet created and Bank linked!", "status": "success"})

@app.route('/api/get_user/<name>', methods=['GET'])
def get_user(name):
    db = get_db()
    clean_name = name.strip()
    if clean_name in db:
        if "bank_balance" not in db[clean_name]:
            db[clean_name]["bank_balance"] = 50000.0
        if "wallet_balance" not in db[clean_name]:
            db[clean_name]["wallet_balance"] = db[clean_name].get("balance", 0.0)
        return jsonify({"status": "success", "data": db[clean_name]})
    return jsonify({"msg": "User not found!", "status": "error"}), 404

@app.route('/api/deposit', methods=['POST'])
def deposit():
    time.sleep(0.8) # Simulating network latency
    req = request.json
    user = req.get("user", "").strip()
    
    # STRICT INPUT VALIDATION
    try:
        amt = float(req.get("amount", 0))
    except ValueError:
        return jsonify({"msg": "Invalid amount format!", "status": "error"}), 400
        
    if amt <= 0 or amt > 50000:
        return jsonify({"msg": "Amount must be between ₹1 and ₹50,000", "status": "error"}), 400

    db = get_db()
    if user in db:
        # WALLET BUSINESS LOGIC LIMIT
        if db[user].get("wallet_balance", 0) + amt > 100000:
            return jsonify({"msg": "Wallet limit of ₹1,00,000 exceeded!", "status": "error"}), 400

        if db[user].get("bank_balance", 0) >= amt:
            db[user]["bank_balance"] -= amt
            db[user]["wallet_balance"] = db[user].get("wallet_balance", 0) + amt
            db[user]["stats"]["in"] += amt
            
            log = {
                "txn_id": generate_txn_id(), 
                "type": "CREDIT", 
                "category": "Bank Load",
                "desc": f"Loaded ₹{amt} from Bank", 
                "dt": datetime.now().strftime("%d %b, %H:%M")
            }
            db[user]["history"].append(log)
            save_db(db)
            return jsonify({"msg": "Bank Transfer Successful!", "status": "success"})
        return jsonify({"msg": "Insufficient Bank Funds!", "status": "error"}), 400
    return jsonify({"msg": "Invalid Request", "status": "error"}), 400

@app.route('/api/request_pay_otp', methods=['POST'])
def request_pay_otp():
    time.sleep(0.5)
    req = request.json
    sender = req.get("from", "").strip()
    otp = str(random.randint(1000, 9999))
    pending_otps[sender] = otp
    
    # PROFESSIONAL MOCK SMS GATEWAY LOGGING
    print("\n" + "="*55)
    print(f"[SYSTEM LOG] - {datetime.now().strftime('%Y-%m-%d %H:%M:%S')}")
    print(f"[MOCK SMS API] Intercepted outgoing OTP request.")
    print(f"[DESTINATION] User: {sender}")
    print(f"[PAYLOAD] Your NovaWallet Security Code is: {otp}")
    print(f"[STATUS] 200 OK - Message logged to secure terminal.")
    print("="*55 + "\n")
    
    return jsonify({"msg": "OTP Generated via Mock SMS Gateway!", "status": "success"})

@app.route('/api/confirm_pay', methods=['POST'])
def confirm_pay():
    time.sleep(1.2) # Simulating secure verification latency
    req = request.json
    sender = req.get("from", "").strip()
    receiver = req.get("to", "").strip()
    category = req.get("category", "Transfer") # Get Category Tag
    user_otp = req.get("otp", "").strip()
    
    # STRICT INPUT VALIDATION
    try:
        amt = float(req.get("amount", 0))
    except ValueError:
        return jsonify({"msg": "Invalid amount format!", "status": "error"}), 400
        
    if amt <= 0 or amt > 50000:
        return jsonify({"msg": "Transfer must be between ₹1 and ₹50,000", "status": "error"}), 400
    
    if pending_otps.get(sender) != user_otp:
        return jsonify({"msg": "Invalid OTP Code!", "status": "error"}), 401
    
    db = get_db()
    if sender not in db:
        return jsonify({"msg": f"Sender '{sender}' not found!", "status": "error"}), 404
    if receiver not in db:
        return jsonify({"msg": f"Recipient '{receiver}' not found! Check spelling.", "status": "error"}), 404
    
    # WALLET LIMIT CHECK
    if db[receiver].get("wallet_balance", 0) + amt > 100000:
        return jsonify({"msg": "Receiver's wallet cannot hold more than ₹1 Lakh!", "status": "error"}), 400
    
    if db[sender].get("wallet_balance", 0) >= amt:
        db[sender]["wallet_balance"] -= amt
        db[receiver]["wallet_balance"] = db[receiver].get("wallet_balance", 0) + amt
        
        db[sender]["stats"]["out"] += amt
        db[receiver]["stats"]["in"] += amt
        
        txn = generate_txn_id()
        t_now = datetime.now().strftime("%d %b, %H:%M")
        
        # Save with Category Tag
        db[sender]["history"].append({"txn_id": txn, "type": "DEBIT", "category": category, "desc": f"Paid ₹{amt} to {receiver}", "dt": t_now})
        db[receiver]["history"].append({"txn_id": txn, "type": "CREDIT", "category": category, "desc": f"Received ₹{amt} from {sender}", "dt": t_now})
        
        save_db(db)
        del pending_otps[sender] 
        return jsonify({"msg": f"Success! ID: {txn}", "status": "success"})
    
    return jsonify({"msg": "Insufficient Wallet Funds!", "status": "error"}), 400

if __name__ == '__main__':
    app.run(debug=True, port=5000)