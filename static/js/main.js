/**
 * NovaWallet — Core Client Application Logic
 *
 * Implements:
 * 1. Dark Mode Toggle with localStorage persistence & system preference fallback.
 * 2. JWT Authentication (Bearer token stored in localStorage, attached to all requests).
 * 3. Animated Balance Counter (CountUp animation).
 * 4. Transaction Filtering by chips (All, Credits, Debits, Food, Shopping, Bills).
 * 5. Statement Export (CSV and PDF generation).
 * 6. Peer-to-Peer Request Money & Pending Requests approval/decline workflow.
 * 7. Split Bill Modal with participant tags, equal division & batch requests.
 * 8. Fallback dialog click handling for light-dismiss on non-supporting browsers.
 */

(() => {
    'use strict';

    // -------------------------------------------------------------------------
    // Configuration & State
    // -------------------------------------------------------------------------
    const API_BASE = window.location.origin + '/api';

    const state = {
        token: localStorage.getItem('nova_jwt') || null,
        activeUser: localStorage.getItem('nova_user') || null,
        userData: null,
        walletChart: null,
        activeFilter: 'all',
        splitParticipants: [],
        currentWalletBalance: 0,
        currentBankBalance: 0,
        pendingApprovalRequestId: null
    };

    // -------------------------------------------------------------------------
    // Utility Helpers
    // -------------------------------------------------------------------------
    function showToast(message, isError = false) {
        const toast = document.getElementById('toast');
        if (!toast) return;
        toast.textContent = message;
        toast.classList.remove('error');
        if (isError) toast.classList.add('error');
        toast.classList.add('show');
        clearTimeout(toast._timer);
        toast._timer = setTimeout(() => {
            toast.classList.remove('show');
        }, 3200);
    }

    function toggleBtnLoading(btnId, isLoading, defaultHtml) {
        const btn = document.getElementById(btnId);
        if (!btn) return;
        if (isLoading) {
            btn.disabled = true;
            btn.dataset.originalText = btn.innerHTML;
            btn.innerHTML = `<span style="display:inline-flex;align-items:center;gap:8px;">⏳ Processing...</span>`;
        } else {
            btn.disabled = false;
            btn.innerHTML = defaultHtml || btn.dataset.originalText || 'Submit';
        }
    }

    /**
     * Authenticated Fetch Wrapper
     */
    async function apiRequest(endpoint, options = {}) {
        const url = `${API_BASE}${endpoint}`;
        const headers = {
            'Content-Type': 'application/json',
            'ngrok-skip-browser-warning': 'true',
            ...(options.headers || {})
        };

        if (state.token) {
            headers['Authorization'] = `Bearer ${state.token}`;
        }

        try {
            const res = await fetch(url, { ...options, headers });
            const data = await res.json().catch(() => ({}));

            if (res.status === 401 && data.auth_error) {
                showToast(data.msg || 'Session expired. Please sign in.', true);
                doLogout();
                throw new Error('Unauthorized');
            }

            if (!res.ok) {
                throw new Error(data.msg || `Request failed (${res.status})`);
            }

            return data;
        } catch (err) {
            throw err;
        }
    }

    // -------------------------------------------------------------------------
    // Number Formatting & CountUp Animation
    // -------------------------------------------------------------------------
    function formatINR(val) {
        const num = Number(val) || 0;
        return '₹' + num.toLocaleString('en-IN', {
            minimumFractionDigits: 2,
            maximumFractionDigits: 2
        });
    }

    /**
     * Smooth CountUp Animation
     */
    function animateValue(element, start, end, duration = 800) {
        if (!element) return;
        if (isNaN(start)) start = 0;
        if (isNaN(end)) end = 0;
        if (start === end) {
            element.textContent = formatINR(end);
            return;
        }

        const startTime = performance.now();

        function update(currentTime) {
            const elapsed = currentTime - startTime;
            const progress = Math.min(elapsed / duration, 1);
            // Ease out cubic
            const ease = 1 - Math.pow(1 - progress, 3);
            const current = start + (end - start) * ease;

            element.textContent = formatINR(current);

            if (progress < 1) {
                requestAnimationFrame(update);
            } else {
                element.textContent = formatINR(end);
                element.classList.add('bump');
                setTimeout(() => element.classList.remove('bump'), 600);
            }
        }

        requestAnimationFrame(update);
    }

    // -------------------------------------------------------------------------
    // Theme Management (Emerald Light / Sleek Dark)
    // -------------------------------------------------------------------------
    function initTheme() {
        const meta = document.querySelector('meta[name="color-scheme"]');
        const stored = localStorage.getItem('color-scheme');
        if (stored && meta) {
            meta.content = stored;
        }

        document.querySelectorAll('[data-action="toggle-theme"]').forEach(btn => {
            btn.addEventListener('click', () => {
                const current = meta.content;
                let target;

                if (current === 'light dark') {
                    const prefersDark = window.matchMedia('(prefers-color-scheme: dark)').matches;
                    target = prefersDark ? 'light' : 'dark';
                } else if (current === 'dark') {
                    target = 'light';
                } else {
                    target = 'dark';
                }

                meta.content = target;
                localStorage.setItem('color-scheme', target);
                showToast(`Switched to ${target} mode`);
            });
        });
    }

    // -------------------------------------------------------------------------
    // Authentication Flow (JWT-Extended)
    // -------------------------------------------------------------------------
    function initAuth() {
        const authForm = document.getElementById('authForm');
        const authTabs = document.getElementById('authTabs');
        const tabLogin = document.getElementById('tabLogin');
        const tabSignup = document.getElementById('tabSignup');
        const authSubtitle = document.getElementById('authSubtitle');
        const authSubmitBtn = document.getElementById('authSubmitBtn');
        const pwToggle = document.getElementById('pwToggle');
        const passwordInput = document.getElementById('passwordInput');

        if (pwToggle && passwordInput) {
            pwToggle.addEventListener('click', () => {
                const isPw = passwordInput.type === 'password';
                passwordInput.type = isPw ? 'text' : 'password';
                pwToggle.setAttribute('aria-pressed', String(isPw));
                pwToggle.setAttribute('aria-label', isPw ? 'Hide password' : 'Show password');
            });
        }

        function setMode(mode) {
            authForm.dataset.mode = mode;
            authTabs.dataset.mode = mode;
            const isLogin = mode === 'login';
            tabLogin.setAttribute('aria-selected', String(isLogin));
            tabSignup.setAttribute('aria-selected', String(!isLogin));

            if (isLogin) {
                authSubtitle.textContent = 'Sign in to your secure wallet';
                authSubmitBtn.textContent = 'Secure Login';
                passwordInput.setAttribute('autocomplete', 'current-password');
            } else {
                authSubtitle.textContent = 'Create your account & link bank';
                authSubmitBtn.textContent = 'Create Account & Link Bank';
                passwordInput.setAttribute('autocomplete', 'new-password');
            }
        }

        tabLogin?.addEventListener('click', () => setMode('login'));
        tabSignup?.addEventListener('click', () => setMode('signup'));

        authForm?.addEventListener('submit', async (e) => {
            e.preventDefault();
            const mode = authForm.dataset.mode;
            const username = document.getElementById('userInput')?.value.trim();
            const password = document.getElementById('passwordInput')?.value;

            if (!username) return showToast('Please enter your username', true);
            if (!password) return showToast('Please enter your password', true);

            if (mode === 'login') {
                toggleBtnLoading('authSubmitBtn', true);
                try {
                    const res = await apiRequest('/login', {
                        method: 'POST',
                        body: JSON.stringify({ user: username, password })
                    });
                    handleAuthSuccess(res.access_token, res.username || username);
                } catch (err) {
                    showToast(err.message, true);
                } finally {
                    toggleBtnLoading('authSubmitBtn', false, 'Secure Login');
                }
            } else {
                const email = document.getElementById('emailInput')?.value.trim();
                const phone = document.getElementById('phoneInput')?.value.trim();
                if (!email || !phone) return showToast('Email and phone are required for signup', true);
                if (password.length < 8) return showToast('Password must be at least 8 characters', true);

                toggleBtnLoading('authSubmitBtn', true);
                try {
                    const res = await apiRequest('/signup', {
                        method: 'POST',
                        body: JSON.stringify({ user: username, email, phone, password })
                    });
                    showToast(res.msg || 'Account created successfully!');
                    handleAuthSuccess(res.access_token, res.username || username);
                } catch (err) {
                    showToast(err.message, true);
                } finally {
                    toggleBtnLoading('authSubmitBtn', false, 'Create Account & Link Bank');
                }
            }
        });

        document.getElementById('logoutBtn')?.addEventListener('click', doLogout);
    }

    function handleAuthSuccess(token, username) {
        state.token = token;
        state.activeUser = username;
        localStorage.setItem('nova_jwt', token);
        localStorage.setItem('nova_user', username);

        document.getElementById('auth').style.display = 'none';
        document.getElementById('dashboard').style.display = 'block';
        document.getElementById('userBadge').textContent = '@' + username.toLowerCase();

        fetchUserData();
        checkDeepLinkPay();
    }

    function doLogout() {
        state.token = null;
        state.activeUser = null;
        state.userData = null;
        localStorage.removeItem('nova_jwt');
        localStorage.removeItem('nova_user');
        window.location.reload();
    }

    // -------------------------------------------------------------------------
    // Dashboard & State Refresh
    // -------------------------------------------------------------------------
    async function fetchUserData() {
        if (!state.token) return;

        try {
            const res = await apiRequest('/me');
            if (res.status === 'success' && res.data) {
                state.userData = res.data;
                renderDashboard(res.data);
            }
        } catch (err) {
            console.error('Failed to load user data', err);
        }
    }

    function renderDashboard(data) {
        // Balances
        const walletEl = document.getElementById('viewWallet');
        const bankEl = document.getElementById('viewBank');

        walletEl?.classList.remove('skeleton');
        const newWalletBal = Number(data.wallet_balance || 0);
        const newBankBal = Number(data.bank_balance || 0);

        animateValue(walletEl, state.currentWalletBalance, newWalletBal);
        if (bankEl) bankEl.textContent = formatINR(newBankBal);

        state.currentWalletBalance = newWalletBal;
        state.currentBankBalance = newBankBal;

        // Analytics
        const inAmt = Number(data.stats?.in || 0);
        const outAmt = Number(data.stats?.out || 0);
        document.getElementById('txtIn').textContent = formatINR(inAmt);
        document.getElementById('txtOut').textContent = formatINR(outAmt);
        drawChart(inAmt, outAmt);

        // Requests
        renderRequests(data.requests);

        // Transactions History
        renderHistory();
    }

    function drawChart(inVal, outVal) {
        const canvas = document.getElementById('chartCanvas');
        if (!canvas || typeof Chart === 'undefined') return;

        if (state.walletChart) {
            state.walletChart.destroy();
        }

        const ctx = canvas.getContext('2d');
        const isDark = document.querySelector('meta[name="color-scheme"]')?.content === 'dark';

        state.walletChart = new Chart(ctx, {
            type: 'doughnut',
            data: {
                datasets: [{
                    data: [inVal || 0.001, outVal || 0.001],
                    backgroundColor: ['#10b981', '#ef4444'],
                    borderWidth: 0,
                    hoverOffset: 4
                }]
            },
            options: {
                cutout: '75%',
                plugins: {
                    legend: { display: false },
                    tooltip: {
                        callbacks: {
                            label: (ctx) => ` ₹${Number(ctx.raw).toFixed(2)}`
                        }
                    }
                },
                maintainAspectRatio: false
            }
        });
    }

    // -------------------------------------------------------------------------
    // Transaction History & Dynamic Filtering
    // -------------------------------------------------------------------------
    function initFilters() {
        const filterRow = document.getElementById('filterRow');
        if (!filterRow) return;

        filterRow.addEventListener('click', (e) => {
            const chip = e.target.closest('.chip');
            if (!chip) return;

            filterRow.querySelectorAll('.chip').forEach(c => {
                c.setAttribute('aria-pressed', 'false');
            });
            chip.setAttribute('aria-pressed', 'true');
            state.activeFilter = chip.dataset.filter || 'all';
            renderHistory();
        });
    }

    function getFilteredHistory() {
        if (!state.userData?.history) return [];
        const filter = state.activeFilter;

        return state.userData.history.filter(t => {
            if (filter === 'all') return true;
            if (filter === 'credit') return t.type === 'CREDIT';
            if (filter === 'debit') return t.type === 'DEBIT';
            // Category matches
            return (t.category || '').toLowerCase() === filter.toLowerCase();
        });
    }

    function renderHistory() {
        const container = document.getElementById('historyList');
        if (!container) return;

        const txns = getFilteredHistory();

        if (!txns.length) {
            container.innerHTML = `
                <div class="empty-state">
                    <p>No transactions found for "${state.activeFilter}".</p>
                </div>
            `;
            return;
        }

        let html = '';
        txns.forEach(t => {
            const isCredit = t.type === 'CREDIT';
            const cat = t.category || (t.kind === 'LOAD' ? 'Bank Load' : 'Transfer');
            const iconSvg = isCredit
                ? `<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"></path><polyline points="7 10 12 15 17 10"></polyline><line x1="12" y1="15" x2="12" y2="3"></line></svg>`
                : `<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><line x1="22" y1="2" x2="11" y2="13"></line><polygon points="22 2 15 22 11 13 2 9 22 2"></polygon></svg>`;

            const dtDisplay = t.timestamp ? formatTimestamp(t.timestamp) : 'Recent';
            const noteHtml = t.note ? `<div class="note-text">"${escapeHtml(t.note)}"</div>` : '';

            html += `
                <div class="history-item">
                    <div class="history-left">
                        <div class="history-icon ${isCredit ? 'in' : 'out'}">${iconSvg}</div>
                        <div>
                            <div class="desc-text">
                                ${escapeHtml(t.desc)}
                                <span class="category-pill">${escapeHtml(cat)}</span>
                            </div>
                            <div class="date-text">${dtDisplay} &bull; ${escapeHtml(t.txn_id)}</div>
                            ${noteHtml}
                        </div>
                    </div>
                    <div class="amt-text ${isCredit ? 'credit' : 'debit'}">
                        ${isCredit ? '+' : '-'}₹${Number(t.amount).toLocaleString('en-IN', { minimumFractionDigits: 2 })}
                    </div>
                </div>
            `;
        });

        container.innerHTML = html;
    }

    function formatTimestamp(isoStr) {
        try {
            const d = new Date(isoStr);
            const months = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
            const day = d.getDate();
            const mon = months[d.getMonth()];
            const hh = String(d.getHours()).padStart(2, '0');
            const mm = String(d.getMinutes()).padStart(2, '0');
            return `${day} ${mon}, ${hh}:${mm}`;
        } catch {
            return isoStr;
        }
    }

    function escapeHtml(str) {
        if (!str) return '';
        return String(str)
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;');
    }

    // -------------------------------------------------------------------------
    // Statement Export (CSV & PDF)
    // -------------------------------------------------------------------------
    function initExport() {
        const csvBtn = document.getElementById('exportCsvBtn');
        const pdfBtn = document.getElementById('exportPdfBtn');

        csvBtn?.addEventListener('click', exportCSV);
        pdfBtn?.addEventListener('click', exportPDF);
    }

    function exportCSV() {
        const txns = state.userData?.history || [];
        if (!txns.length) return showToast('No transactions to export', true);

        const headers = ['Transaction ID', 'Type', 'Category', 'Description', 'Amount (INR)', 'Timestamp', 'Note'];
        const rows = txns.map(t => [
            t.txn_id,
            t.type,
            t.category,
            `"${(t.desc || '').replace(/"/g, '""')}"`,
            t.amount,
            t.timestamp || '',
            `"${(t.note || '').replace(/"/g, '""')}"`
        ]);

        const csvContent = 'data:text/csv;charset=utf-8,' +
            [headers.join(','), ...rows.map(e => e.join(','))].join('\n');

        const encodedUri = encodeURI(csvContent);
        const link = document.createElement('a');
        link.setAttribute('href', encodedUri);
        link.setAttribute('download', `NovaWallet_Statement_${state.activeUser}_${new Date().toISOString().slice(0,10)}.csv`);
        document.body.appendChild(link);
        link.click();
        document.body.removeChild(link);
        showToast('CSV statement downloaded!');
    }

    function exportPDF() {
        const txns = state.userData?.history || [];
        if (!txns.length) return showToast('No transactions to export', true);

        // Clean printable window for saving to PDF
        const printWindow = window.open('', '_blank', 'width=800,height=900');
        if (!printWindow) {
            return showToast('Popup blocked! Please allow popups for PDF generation.', true);
        }

        const dateStr = new Date().toLocaleDateString('en-IN', {
            year: 'numeric', month: 'short', day: 'numeric'
        });

        const rowsHtml = txns.map(t => `
            <tr style="border-bottom: 1px solid #e5e7eb;">
                <td style="padding: 10px; font-size: 12px; font-family: monospace;">${escapeHtml(t.txn_id)}</td>
                <td style="padding: 10px; font-size: 13px;">${escapeHtml(t.timestamp ? formatTimestamp(t.timestamp) : '-')}</td>
                <td style="padding: 10px; font-size: 13px;">${escapeHtml(t.desc)}</td>
                <td style="padding: 10px; font-size: 13px;"><span style="background: #f3f4f6; padding: 2px 6px; border-radius: 4px; font-size: 11px;">${escapeHtml(t.category)}</span></td>
                <td style="padding: 10px; font-size: 13px; font-weight: bold; text-align: right; color: ${t.type === 'CREDIT' ? '#10b981' : '#111827'};">
                    ${t.type === 'CREDIT' ? '+' : '-'}₹${Number(t.amount).toFixed(2)}
                </td>
            </tr>
        `).join('');

        printWindow.document.write(`
            <!DOCTYPE html>
            <html>
            <head>
                <title>NovaWallet Account Statement - ${escapeHtml(state.activeUser)}</title>
                <style>
                    body { font-family: 'Inter', system-ui, -apple-system, sans-serif; padding: 40px; color: #111827; }
                    .header { display: flex; justify-content: space-between; align-items: center; border-bottom: 3px solid #10b981; padding-bottom: 20px; margin-bottom: 30px; }
                    .brand { font-size: 26px; font-weight: 900; color: #10b981; }
                    .meta { text-align: right; font-size: 13px; color: #6b7280; }
                    .summary { display: grid; grid-template-columns: 1fr 1fr 1fr; gap: 20px; background: #ecfdf5; padding: 18px; border-radius: 12px; margin-bottom: 30px; }
                    .card { font-size: 12px; color: #065f46; font-weight: 600; }
                    .card .val { font-size: 20px; font-weight: 900; color: #047857; margin-top: 4px; }
                    table { width: 100%; border-collapse: collapse; text-align: left; }
                    th { padding: 10px; background: #f9fafb; font-size: 12px; text-transform: uppercase; color: #6b7280; border-bottom: 2px solid #e5e7eb; }
                    @media print { body { padding: 0; } }
                </style>
            </head>
            <body>
                <div class="header">
                    <div>
                        <div class="brand">NovaWallet</div>
                        <div style="font-size: 14px; color: #6b7280; font-weight: 600;">Official Account Statement</div>
                    </div>
                    <div class="meta">
                        <div>Account: <strong>@${escapeHtml(state.activeUser)}</strong></div>
                        <div>Generated: ${dateStr}</div>
                    </div>
                </div>

                <div class="summary">
                    <div class="card">
                        Wallet Balance
                        <div class="val">${formatINR(state.userData?.wallet_balance || 0)}</div>
                    </div>
                    <div class="card">
                        Total Inflow
                        <div class="val">${formatINR(state.userData?.stats?.in || 0)}</div>
                    </div>
                    <div class="card">
                        Total Outflow
                        <div class="val">${formatINR(state.userData?.stats?.out || 0)}</div>
                    </div>
                </div>

                <table>
                    <thead>
                        <tr>
                            <th>Txn ID</th>
                            <th>Date</th>
                            <th>Description</th>
                            <th>Category</th>
                            <th style="text-align: right;">Amount</th>
                        </tr>
                    </thead>
                    <tbody>
                        ${rowsHtml}
                    </tbody>
                </table>

                <div style="margin-top: 40px; font-size: 11px; color: #9ca3af; text-align: center;">
                    This is a computer-generated statement certified by NovaWallet Security Core.
                </div>
                <script>
                    window.onload = () => {
                        window.print();
                    };
                </script>
            </body>
            </html>
        `);
        printWindow.document.close();
    }

    // -------------------------------------------------------------------------
    // Peer-to-Peer Payment Requests Flow
    // -------------------------------------------------------------------------
    function renderRequests(requests) {
        const section = document.getElementById('requestsSection');
        const countBadge = document.getElementById('requestCount');
        const incomingList = document.getElementById('incomingList');
        const outgoingList = document.getElementById('outgoingList');
        const outgoingWrap = document.getElementById('outgoingWrap');

        const incoming = requests?.incoming || [];
        const outgoing = requests?.outgoing || [];

        if (countBadge) countBadge.textContent = incoming.length;

        if (incoming.length === 0 && outgoing.length === 0) {
            if (section) section.style.display = 'none';
            return;
        }

        if (section) section.style.display = 'block';

        // Render Incoming
        if (incomingList) {
            if (!incoming.length) {
                incomingList.innerHTML = `<p style="font-size:13px;color:var(--text-faint);padding:6px 0;">No incoming payment requests.</p>`;
            } else {
                incomingList.innerHTML = incoming.map(r => `
                    <div class="request-card" id="reqCard_${r.request_id}">
                        <div class="request-top">
                            <div class="avatar">${escapeHtml(r.requester.substring(0,2))}</div>
                            <div class="request-info">
                                <div class="request-title"><strong>@${escapeHtml(r.requester)}</strong> requested funds</div>
                                <div class="request-meta">
                                    <span>${escapeHtml(r.category || 'Transfer')}</span>
                                    <span>&bull;</span>
                                    <span>${r.created_at ? formatTimestamp(r.created_at) : 'Just now'}</span>
                                    ${r.note ? `<span>&bull; "${escapeHtml(r.note)}"</span>` : ''}
                                </div>
                            </div>
                            <div class="request-amt">${formatINR(r.amount)}</div>
                        </div>

                        <div class="request-actions">
                            <button type="button" class="btn-approve" onclick="window.NovaApp.initApproveRequest('${r.request_id}')">
                                Approve &amp; Pay
                            </button>
                            <button type="button" class="btn-decline" onclick="window.NovaApp.declineRequest('${r.request_id}')">
                                Decline
                            </button>
                        </div>

                        <div class="request-otp" id="otpBox_${r.request_id}">
                            <input type="text" id="otpInput_${r.request_id}" maxlength="4" placeholder="OTP" inputmode="numeric">
                            <button type="button" onclick="window.NovaApp.confirmApproveRequest('${r.request_id}')">Confirm</button>
                        </div>
                    </div>
                `).join('');
            }
        }

        // Render Outgoing
        if (outgoingList && outgoingWrap) {
            if (!outgoing.length) {
                outgoingWrap.style.display = 'none';
            } else {
                outgoingWrap.style.display = 'block';
                outgoingList.innerHTML = outgoing.slice(0, 5).map(r => `
                    <div class="request-card outgoing">
                        <div class="request-top">
                            <div class="avatar">${escapeHtml(r.payer.substring(0,2))}</div>
                            <div class="request-info">
                                <div class="request-title">Requested from <strong>@${escapeHtml(r.payer)}</strong></div>
                                <div class="request-meta">
                                    <span class="status-pill status-${r.status}">${r.status}</span>
                                    <span>&bull;</span>
                                    <span>${r.created_at ? formatTimestamp(r.created_at) : 'Just now'}</span>
                                </div>
                            </div>
                            <div class="request-amt">${formatINR(r.amount)}</div>
                        </div>
                        ${r.status === 'PENDING' ? `
                            <div style="margin-top: 8px; text-align: right;">
                                <button type="button" class="btn-link" onclick="window.NovaApp.cancelRequest('${r.request_id}')">Cancel Request</button>
                            </div>
                        ` : ''}
                    </div>
                `).join('');
            }
        }
    }

    async function initApproveRequest(requestId) {
        try {
            showToast('Generating security OTP...');
            const res = await apiRequest('/request_pay_otp', {
                method: 'POST',
                body: JSON.stringify({ request_id: requestId })
            });

            showToast('Check terminal for OTP code!');
            const card = document.getElementById(`reqCard_${requestId}`);
            if (card) {
                card.classList.add('otp-open');
                const inp = document.getElementById(`otpInput_${requestId}`);
                inp?.focus();
            }
        } catch (err) {
            showToast(err.message, true);
        }
    }

    async function confirmApproveRequest(requestId) {
        const inp = document.getElementById(`otpInput_${requestId}`);
        const otp = inp?.value.trim();
        if (!otp) return showToast('Please enter the 4-digit OTP', true);

        try {
            showToast('Authorizing payment...');
            const res = await apiRequest(`/requests/${requestId}/approve`, {
                method: 'POST',
                body: JSON.stringify({ otp })
            });

            showToast(res.msg || 'Payment approved and transferred!');
            fetchUserData();
        } catch (err) {
            showToast(err.message, true);
        }
    }

    async function declineRequest(requestId) {
        if (!confirm('Are you sure you want to decline this payment request?')) return;
        try {
            const res = await apiRequest(`/requests/${requestId}/decline`, { method: 'POST' });
            showToast(res.msg || 'Request declined');
            fetchUserData();
        } catch (err) {
            showToast(err.message, true);
        }
    }

    async function cancelRequest(requestId) {
        try {
            const res = await apiRequest(`/requests/${requestId}/cancel`, { method: 'POST' });
            showToast(res.msg || 'Request cancelled');
            fetchUserData();
        } catch (err) {
            showToast(err.message, true);
        }
    }

    // -------------------------------------------------------------------------
    // Quick Actions & Panels (Deposit, Send, Request)
    // -------------------------------------------------------------------------
    function initPanels() {
        // Tab / Panel toggles
        document.querySelectorAll('.action-btn[data-panel]').forEach(btn => {
            btn.addEventListener('click', () => {
                const targetId = btn.dataset.panel;
                togglePanel(targetId);
            });
        });

        // Deposit form
        document.getElementById('depositForm')?.addEventListener('submit', async (e) => {
            e.preventDefault();
            const amt = document.getElementById('depAmt')?.value;
            if (!amt || Number(amt) <= 0) return showToast('Please enter a valid amount', true);

            toggleBtnLoading('depBtn', true);
            try {
                const res = await apiRequest('/deposit', {
                    method: 'POST',
                    body: JSON.stringify({ amount: amt })
                });
                showToast(res.msg || 'Bank Transfer Successful!');
                document.getElementById('depAmt').value = '';
                togglePanel('depositArea');
                fetchUserData();
            } catch (err) {
                showToast(err.message, true);
            } finally {
                toggleBtnLoading('depBtn', false, 'Verify & Load Funds');
            }
        });

        // Send Money OTP Step 1
        document.getElementById('payStep1')?.addEventListener('submit', async (e) => {
            e.preventDefault();
            const to = document.getElementById('payTo')?.value.trim();
            const amt = document.getElementById('payAmt')?.value;
            if (!to || !amt || Number(amt) <= 0) return showToast('Enter receiver and a valid amount', true);

            toggleBtnLoading('reqOtpBtn', true);
            try {
                const res = await apiRequest('/request_pay_otp', {
                    method: 'POST',
                    body: JSON.stringify({ to, amount: amt })
                });
                showToast('OTP code sent! Check terminal.');
                document.getElementById('payStep1').style.display = 'none';
                document.getElementById('payStep2').style.display = 'block';
                document.getElementById('payOtp')?.focus();
            } catch (err) {
                showToast(err.message, true);
            } finally {
                toggleBtnLoading('reqOtpBtn', false, 'Generate OTP');
            }
        });

        document.getElementById('payBackBtn')?.addEventListener('click', () => {
            document.getElementById('payStep2').style.display = 'none';
            document.getElementById('payStep1').style.display = 'block';
        });

        // Send Money Confirmation Step 2
        document.getElementById('payStep2')?.addEventListener('submit', async (e) => {
            e.preventDefault();
            const to = document.getElementById('payTo')?.value.trim();
            const amt = document.getElementById('payAmt')?.value;
            const category = document.getElementById('payCat')?.value;
            const otp = document.getElementById('payOtp')?.value.trim();

            if (!otp) return showToast('Please enter the OTP', true);

            toggleBtnLoading('confPayBtn', true);
            try {
                const res = await apiRequest('/confirm_pay', {
                    method: 'POST',
                    body: JSON.stringify({ to, amount: amt, category, otp })
                });
                showToast(res.msg || 'Transfer successful!');
                document.getElementById('payStep2').style.display = 'none';
                document.getElementById('payStep1').style.display = 'block';
                document.getElementById('payTo').value = '';
                document.getElementById('payAmt').value = '';
                document.getElementById('payOtp').value = '';
                togglePanel('payArea');
                fetchUserData();
            } catch (err) {
                showToast(err.message, true);
            } finally {
                toggleBtnLoading('confPayBtn', false, 'Confirm Transaction');
            }
        });

        // Request Money Form
        document.getElementById('requestForm')?.addEventListener('submit', async (e) => {
            e.preventDefault();
            const payer = document.getElementById('reqFrom')?.value.trim();
            const amt = document.getElementById('reqAmt')?.value;
            const note = document.getElementById('reqNote')?.value.trim();

            if (!payer || !amt || Number(amt) <= 0) return showToast('Enter user and valid amount', true);

            toggleBtnLoading('reqMoneyBtn', true);
            try {
                const res = await apiRequest('/request_money', {
                    method: 'POST',
                    body: JSON.stringify({ payer, amount: amt, note, category: 'Transfer' })
                });
                showToast(res.msg || 'Payment request sent!');
                document.getElementById('reqFrom').value = '';
                document.getElementById('reqAmt').value = '';
                document.getElementById('reqNote').value = '';
                togglePanel('requestArea');
                fetchUserData();
            } catch (err) {
                showToast(err.message, true);
            } finally {
                toggleBtnLoading('reqMoneyBtn', false, 'Send Request');
            }
        });

        // Receive / QR Button
        document.getElementById('actReceive')?.addEventListener('click', showReceiveQR);
    }

    function togglePanel(id) {
        ['depositArea', 'payArea', 'requestArea'].forEach(areaId => {
            const el = document.getElementById(areaId);
            if (!el) return;
            if (areaId !== id) {
                el.style.display = 'none';
            } else {
                el.style.display = (el.style.display === 'block') ? 'none' : 'block';
                if (el.style.display === 'block') {
                    el.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
                }
            }
        });
    }

    function showReceiveQR() {
        const modal = document.getElementById('qrModal');
        const qrImg = document.getElementById('qrImg');
        if (!modal || !qrImg) return;

        const payLink = `${window.location.origin}${window.location.pathname}?payTo=${encodeURIComponent(state.activeUser || '')}`;
        qrImg.src = `https://api.qrserver.com/v1/create-qr-code/?size=200x200&data=${encodeURIComponent(payLink)}&color=111827&bgcolor=ffffff`;

        modal.showModal();
    }

    function checkDeepLinkPay() {
        const params = new URLSearchParams(window.location.search);
        const pTo = params.get('payTo');
        if (pTo && pTo.trim() && pTo.trim().toLowerCase() !== (state.activeUser || '').toLowerCase()) {
            togglePanel('payArea');
            const toInput = document.getElementById('payTo');
            if (toInput) toInput.value = pTo.trim();
            showToast(`Transfer to @${pTo} initiated!`);
            window.history.replaceState({}, '', window.location.pathname);
        }
    }

    // -------------------------------------------------------------------------
    // Advanced Feature: Split Bill Modal & Logic
    // -------------------------------------------------------------------------
    function initSplitBill() {
        const actSplit = document.getElementById('actSplit');
        const splitModal = document.getElementById('splitModal');
        const splitCloseBtn = document.getElementById('splitCloseBtn');
        const splitForm = document.getElementById('splitForm');
        const splitSearch = document.getElementById('splitSearch');
        const splitSuggestions = document.getElementById('splitSuggestions');
        const splitTotal = document.getElementById('splitTotal');
        const splitIncludeSelf = document.getElementById('splitIncludeSelf');

        actSplit?.addEventListener('click', () => {
            state.splitParticipants = [];
            renderSplitChips();
            updateSplitCalculation();
            splitModal?.showModal();
        });

        splitCloseBtn?.addEventListener('click', () => {
            splitModal?.close();
        });

        // Search user autosuggest
        let searchTimeout;
        splitSearch?.addEventListener('input', () => {
            clearTimeout(searchTimeout);
            const query = splitSearch.value.trim();
            if (query.length < 1) {
                splitSuggestions.classList.remove('open');
                splitSuggestions.innerHTML = '';
                return;
            }

            searchTimeout = setTimeout(async () => {
                try {
                    const res = await apiRequest(`/users/search?q=${encodeURIComponent(query)}`);
                    const users = (res.users || []).filter(u =>
                        u.toLowerCase() !== (state.activeUser || '').toLowerCase() &&
                        !state.splitParticipants.includes(u)
                    );

                    if (!users.length) {
                        splitSuggestions.innerHTML = `<li style="color:var(--text-faint);cursor:default;">No matching users</li>`;
                    } else {
                        splitSuggestions.innerHTML = users.map(u => `
                            <li onclick="window.NovaApp.addSplitParticipant('${escapeHtml(u)}')">
                                <span class="mini-avatar">${escapeHtml(u.substring(0,2))}</span>
                                <span>@${escapeHtml(u)}</span>
                            </li>
                        `).join('');
                    }
                    splitSuggestions.classList.add('open');
                } catch (e) {}
            }, 250);
        });

        splitSearch?.addEventListener('keydown', (e) => {
            if (e.key === 'Enter') {
                e.preventDefault();
                const val = splitSearch.value.trim();
                if (val) {
                    addSplitParticipant(val);
                }
            }
        });

        // Recompute on amount or checkbox change
        splitTotal?.addEventListener('input', updateSplitCalculation);
        splitIncludeSelf?.addEventListener('change', updateSplitCalculation);

        // Submit Split Bill
        splitForm?.addEventListener('submit', async (e) => {
            e.preventDefault();
            const total = splitTotal?.value;
            const note = document.getElementById('splitNote')?.value.trim() || 'Split bill';
            const category = document.getElementById('splitCat')?.value || 'Food';
            const includeSelf = splitIncludeSelf?.checked;

            if (!total || Number(total) <= 0) return showToast('Please enter a valid bill total', true);
            if (!state.splitParticipants.length) return showToast('Select at least one friend to split with', true);

            toggleBtnLoading('splitSubmitBtn', true);
            try {
                const res = await apiRequest('/split_bill', {
                    method: 'POST',
                    body: JSON.stringify({
                        total,
                        note,
                        category,
                        include_self: includeSelf,
                        usernames: state.splitParticipants
                    })
                });

                showToast(res.msg || 'Split bill requests sent!');
                splitModal?.close();
                splitForm.reset();
                state.splitParticipants = [];
                fetchUserData();
            } catch (err) {
                showToast(err.message, true);
            } finally {
                toggleBtnLoading('splitSubmitBtn', false, 'Send Requests');
            }
        });
    }

    function addSplitParticipant(username) {
        username = username.trim();
        if (!username) return;
        if (username.toLowerCase() === (state.activeUser || '').toLowerCase()) {
            return showToast('You are already included in the split.', true);
        }
        if (state.splitParticipants.includes(username)) {
            return showToast(`${username} is already added.`);
        }

        state.splitParticipants.push(username);
        const splitSearch = document.getElementById('splitSearch');
        const splitSuggestions = document.getElementById('splitSuggestions');
        if (splitSearch) splitSearch.value = '';
        if (splitSuggestions) {
            splitSuggestions.classList.remove('open');
            splitSuggestions.innerHTML = '';
        }

        renderSplitChips();
        updateSplitCalculation();
    }

    function removeSplitParticipant(username) {
        state.splitParticipants = state.splitParticipants.filter(u => u !== username);
        renderSplitChips();
        updateSplitCalculation();
    }

    function renderSplitChips() {
        const container = document.getElementById('splitChips');
        if (!container) return;

        container.innerHTML = state.splitParticipants.map(u => `
            <span class="p-chip">
                <span>@${escapeHtml(u)}</span>
                <button type="button" aria-label="Remove" onclick="window.NovaApp.removeSplitParticipant('${escapeHtml(u)}')">&times;</button>
            </span>
        `).join('');
    }

    function updateSplitCalculation() {
        const total = Number(document.getElementById('splitTotal')?.value || 0);
        const includeSelf = document.getElementById('splitIncludeSelf')?.checked ?? true;
        const count = state.splitParticipants.length + (includeSelf ? 1 : 0);

        const eachEl = document.getElementById('splitEach');
        const summaryEl = document.getElementById('splitSummary');
        const breakdownEl = document.getElementById('splitBreakdown');

        if (count < 2 || total <= 0) {
            if (eachEl) eachEl.textContent = '₹0.00 each';
            if (summaryEl) summaryEl.textContent = 'Add people and an amount to see the breakdown';
            if (breakdownEl) breakdownEl.innerHTML = '';
            return;
        }

        const share = (total / count);
        if (eachEl) eachEl.textContent = formatINR(share) + ' each';
        if (summaryEl) summaryEl.textContent = `Divided equally between ${count} people (${includeSelf ? 'including you' : 'excluding you'})`;

        if (breakdownEl) {
            let breakdownHtml = '';
            if (includeSelf) {
                breakdownHtml += `<li><span>Your share:</span> <strong>${formatINR(share)}</strong></li>`;
            }
            state.splitParticipants.forEach(u => {
                breakdownHtml += `<li><span>Request from @${escapeHtml(u)}:</span> <strong>${formatINR(share)}</strong></li>`;
            });
            breakdownEl.innerHTML = breakdownHtml;
        }
    }

    // -------------------------------------------------------------------------
    // Dialog Fallback for Light-Dismiss (<dialog closedby="any"> support)
    // -------------------------------------------------------------------------
    function initDialogLightDismissFallbacks() {
        document.querySelectorAll('dialog.modal').forEach(dialog => {
            if (!('closedBy' in HTMLDialogElement.prototype)) {
                dialog.addEventListener('click', (event) => {
                    if (event.target !== dialog) return;
                    const rect = dialog.getBoundingClientRect();
                    const isInside = (
                        rect.top <= event.clientY &&
                        event.clientY <= rect.top + rect.height &&
                        rect.left <= event.clientX &&
                        event.clientX <= rect.left + rect.width
                    );
                    if (!isInside) {
                        dialog.close();
                    }
                });
            }
        });
    }

    // -------------------------------------------------------------------------
    // Global Lifecycle Entrypoint
    // -------------------------------------------------------------------------
    document.addEventListener('DOMContentLoaded', () => {
        initTheme();
        initAuth();
        initFilters();
        initExport();
        initPanels();
        initSplitBill();
        initDialogLightDismissFallbacks();

        if (state.token && state.activeUser) {
            document.getElementById('auth').style.display = 'none';
            document.getElementById('dashboard').style.display = 'block';
            document.getElementById('userBadge').textContent = '@' + state.activeUser.toLowerCase();
            fetchUserData();
            checkDeepLinkPay();
        }
    });

    // Expose helpers needed by inline onclick handlers
    window.NovaApp = {
        addSplitParticipant,
        removeSplitParticipant,
        initApproveRequest,
        confirmApproveRequest,
        declineRequest,
        cancelRequest
    };

})();
