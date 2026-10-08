# NovaWallet

[![Python](https://img.shields.io/badge/Python-3.11%2B-3776AB?logo=python&logoColor=white)](https://python.org)
[![Flask](https://img.shields.io/badge/Flask-3.1.3-000000?logo=flask&logoColor=white)](https://flask.palletsprojects.com/)
[![SQLAlchemy](https://img.shields.io/badge/SQLAlchemy-2.0-D71F00?logo=sqlalchemy&logoColor=white)](https://www.sqlalchemy.org/)
[![JWT](https://img.shields.io/badge/Auth-Flask--JWT-F5A623?logo=jsonwebtokens&logoColor=white)](https://flask-jwt-extended.readthedocs.io/)
[![License: MIT](https://img.shields.io/badge/License-MIT-green.svg)](LICENSE)
[![Tests](https://img.shields.io/badge/Tests-Passing-brightgreen)](test_fintech_endpoints.py)

A full-stack digital wallet and payments web application built with Python (Flask) and vanilla JavaScript.

NovaWallet simulates a modern consumer payments app with peer-to-peer transfers, virtual card management, utility bill payments, interactive scratch-card cashback rewards, and goal-based savings vaults. It was built to explore how consumer fintech applications handle core transactional workflows, balance consistency, and state management.

**Live Demo:** [https://novawallet-x6o5.onrender.com/](https://novawallet-x6o5.onrender.com/)

---

## Features

### Payments & Transaction Ledger
- **Peer-to-Peer Transfers**: Send money instantly to any registered user by username.
- **Inward Bank Funding**: Add funds to the wallet from a linked core bank account.
- **Payment Requests**: Request money from other users with accept/decline flows.
- **Integer-Paise Accounting**: All balances and transactions are stored internally as integer paise (`₹1.00 = 100 paise`) to prevent floating-point rounding errors common in financial calculations.
- **Atomic Transfers**: Database transactions lock accounts in deterministic order (`sorted([sender_id, receiver_id])`) to prevent deadlocks and ensure either both accounts update or neither does.

### Virtual Debit Card Controls
- **Instant Freeze / Unfreeze**: Freeze the card with one click. When frozen, transfers and bill payments are blocked on both the client and server.
- **Reveal Card Details**: View the unmasked 16-digit card number and 3-digit CVV on demand with a quick-copy utility.
- **Daily Spend Limit**: Adjust a daily transaction limit slider (`₹5,000` to `₹2,00,000`). Updates are visually instant, debounced to the server, and enforced on all outgoing transactions.
- **Switch Linked Bank**: Toggle the primary funding source between HDFC Bank and ICICI Bank.

### Rewards & Cashback
- **Interactive Scratch Cards**: HTML5 canvas scratch cards with particle dust effects. Once scratched past a threshold, cashback is credited directly to the wallet balance.
- **Realistic Merchant Cashbacks**: Scratch cards reference everyday merchants like Swiggy, Zomato, Amazon Pay, and Blinkit.

### Utility Bill Payments (BBPS Simulation)
- Pay utility bills across multiple categories: Electricity, Mobile Recharge, FASTag, Broadband, and Credit Card.
- Bill fetch simulation using operator and consumer account number.
- 4-digit UPI MPIN confirmation (`1234`) required before money is debited.
- Successful bill payments automatically unlock bonus scratch cards.

### Smart Savings Vaults
- Create ring-fenced savings goals (e.g., Emergency Reserve, Tech Fund).
- Deposit money into vaults or withdraw it back to the wallet anytime.
- Visual progress bars track current savings against the target goal.

### Financial Summary & AI Insights
- Real-time breakdown of liquid balance, bank funds, vault savings, and net worth.
- Expenditure category chart powered by Chart.js.
- Automated financial health analysis (reserve ratios and top spending categories).
- Natural language query box powered by Google Gemini (with rule-based fallback).

### Clean UI & Real-Time Sync
- **No Heavy Frontend Frameworks**: Built using Vanilla JavaScript and Vanilla CSS. Fast load times with zero npm build step.
- **Light & Dark Mode**: Handcrafted theme switcher with full contrast support in both modes.
- **Multi-Tab Sync**: Background polling keeps balances, notifications, and card states in sync across multiple browser tabs.

---

## Tech Stack

- **Backend**: Python 3.11, Flask 3.1, Flask-SQLAlchemy (SQLAlchemy 2.0), Flask-JWT-Extended, Werkzeug
- **Database**: SQLite (Write-Ahead Logging enabled for concurrency) / PostgreSQL compatible
- **Frontend**: HTML5, Vanilla JavaScript (ES6+), Vanilla CSS3, Chart.js
- **Production Server**: Gunicorn WSGI, Render Cloud

---

## Quick Demo Account

You can create a new account on the signup screen, or use the pre-configured demo account:

- **Username**: `priyanshu`
- **Password**: `Nova@123`
- **UPI MPIN**: `1234`
- **Initial Balances**: ₹45,000 (Wallet) | ₹1,50,000 (Bank)

---

## Local Setup

### 1. Clone the repository
```bash
git clone https://github.com/PriyanshuChauhan-007/NovaWallet.git
cd NovaWallet
```

### 2. Create and activate a virtual environment
```bash
# Windows
python -m venv .venv
.venv\Scripts\activate

# macOS / Linux
python3 -m venv .venv
source .venv/bin/activate
```

### 3. Install dependencies
```bash
pip install -r requirements.txt
```

### 4. Configure environment (optional)
```bash
# Windows PowerShell
Copy-Item .env.example .env

# macOS / Linux
cp .env.example .env
```
*(If left unset, the app uses secure local defaults and SQLite).*

### 5. Start the application
```bash
python app.py
```
Open `http://localhost:5000` in your browser.

---

## Automated Tests

The repository includes automated test suites covering authentication, ledger math, card controls, bill payments, rewards, and sync:

```bash
# Run core fintech endpoints test suite
python test_fintech_endpoints.py

# Run authentication and vault test suite
python test_auth_flow.py
```

---

## API Endpoints

| Method | Endpoint | Auth | Description |
|---|---|---|---|
| `POST` | `/api/signup` | Public | Register a new user |
| `POST` | `/api/login` | Public | Log in and receive JWT token |
| `GET` | `/api/me` | JWT | Fetch user profile, balances, and history |
| `POST` | `/api/transfer` | JWT | Send money to another user |
| `POST` | `/api/load` | JWT | Add money to wallet from linked bank |
| `GET` | `/api/directory` | JWT | Search registered users for payments |
| `POST` | `/api/request` | JWT | Create a payment request |
| `POST` | `/api/request/respond` | JWT | Accept or decline a payment request |
| `POST` | `/api/card/freeze` | JWT | Toggle card freeze status |
| `POST` | `/api/card/reveal` | JWT | View unmasked card PAN and CVV |
| `POST` | `/api/card/limit` | JWT | Update daily spend limit |
| `POST` | `/api/card/switch_bank` | JWT | Switch linked primary bank |
| `GET` | `/api/rewards` | JWT | Fetch scratch cards list |
| `POST` | `/api/rewards/claim` | JWT | Claim scratch card cashback |
| `POST` | `/api/bills/fetch` | JWT | Fetch utility bill details |
| `POST` | `/api/bills/pay` | JWT | Pay bill with MPIN |
| `GET` | `/api/vaults` | JWT | View savings goals |
| `POST` | `/api/vaults/deposit` | JWT | Transfer money into vault |
| `POST` | `/api/vaults/withdraw` | JWT | Withdraw money from vault |
| `GET` | `/api/notifications` | JWT | Fetch notification feed |
| `POST` | `/api/notifications/read` | JWT | Mark notifications as read |
| `GET` | `/api/sync` | JWT | Multi-tab sync heartbeat |

---

## Deployment

The app is ready for deployment on **Render**:

1. Push your repository to GitHub.
2. In the Render Dashboard, create a **New Web Service** and connect your repository.
3. Render detects `render.yaml` or use:
   - **Build Command**: `pip install -r requirements.txt`
   - **Start Command**: `gunicorn app:app`
4. Set environment variables:
   - `PYTHON_VERSION`: `3.11.9`
   - `FLASK_SECRET_KEY`: *(random secret string)*
   - `JWT_SECRET_KEY`: *(random secret string)*

---

## Project Structure

```plaintext
NovaWallet/
├── .env.example             # Environment template
├── .gitignore               # Git exclusion rules
├── LICENSE                  # MIT License
├── Procfile                 # Production process file (Gunicorn)
├── README.md                # Project documentation
├── app.py                   # Core Flask app, models, and REST endpoints
├── render.yaml              # Render deployment blueprint
├── requirements.txt         # Python dependencies
├── static/
│   ├── css/
│   │   └── style.css        # Adaptive Light/Dark CSS design system
│   └── js/
│       └── main.js          # Client-side logic, card controls, canvas scratch
├── templates/
│   └── index.html           # Main application template
├── test_auth_flow.py        # Auth & vault test suite
├── test_fintech_endpoints.py# Payments, cards & rewards test suite
└── wallet_data.json         # Legacy fallback seed data
```

---

## License

This project is licensed under the [MIT License](LICENSE).
