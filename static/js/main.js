/**
 * NovaWallet — Core Client Application Logic
 *
 * Implements:
 * 1. Dark Mode Toggle with localStorage persistence & system preference fallback.
 * 2. JWT Authentication (Bearer token stored in localStorage, attached to all requests).
 * 3. Animated Balance Counter (CountUp animation) & UPI VPA Copying.
 * 4. Realistic Linked Bank Instrument with mask/unmask toggle.
 * 5. Quick Amount Pills & Recent Peer Contacts.
 * 6. Cashflow Chart (with ₹0.00 'No Flow' fix) & Spending Category Breakdown.
 * 7. Simulated In-App SMS Notification for OTP & 4-Digit Box Input with auto-advance.
 * 8. Live Transaction Search & Clickable Receipt Modal with Print/Download.
 * 9. Statement Export (CSV and PDF generation).
 * 10. Peer-to-Peer Payment Requests & Split Bill Engine.
 * 11. Quick Demo Account Single-Click Selection.
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
        searchQuery: '',
        splitParticipants: [],
        currentWalletBalance: 0,
        currentBankBalance: 0,
        isBankBalanceMasked: false,
        lastOtpCode: null,
        lastOtpAmount: null
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
            const ease = 1 - Math.pow(1 - progress, 3);
            const current = start + (end - start) * ease;

            element.textContent = formatINR(current);

            if (progress < 1) {
                requestAnimationFrame(update);
            } else {
                element.textContent = formatINR(end);
                element.classList.add('bump');
                setTimeout(() => element.classList.remove('bump'), 500);
            }
        }

        requestAnimationFrame(update);
    }

    // -------------------------------------------------------------------------
    // Theme Management
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

                // Re-render chart to adapt slate colors
                if (state.userData?.stats) {
                    drawChart(Number(state.userData.stats.in || 0), Number(state.userData.stats.out || 0));
                }
            });
        });
    }

    // -------------------------------------------------------------------------
    // Authentication Flow & Demo Quick-Fill
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
                authSubtitle.textContent = 'Sign in to your secure digital wallet';
                authSubmitBtn.textContent = 'Sign In to Workspace';
                passwordInput.setAttribute('autocomplete', 'current-password');
            } else {
                authSubtitle.textContent = 'Create your account & link UPI bank';
                authSubmitBtn.textContent = 'Create Free Account';
                passwordInput.setAttribute('autocomplete', 'new-password');
            }
        }

        tabLogin?.addEventListener('click', () => setMode('login'));
        tabSignup?.addEventListener('click', () => setMode('signup'));

        // Quick Demo Accounts single-click autofill
        document.querySelectorAll('.demo-chip').forEach(chip => {
            chip.addEventListener('click', () => {
                const user = chip.dataset.user;
                const pass = chip.dataset.pass;
                const userInp = document.getElementById('userInput');
                const passInp = document.getElementById('passwordInput');
                if (userInp && passInp) {
                    setMode('login');
                    userInp.value = user;
                    passInp.value = pass;
                    showToast(`Loaded demo credentials for ${user}!`);
                }
            });
        });

        authForm?.addEventListener('submit', async (e) => {
            e.preventDefault();
            const mode = authForm.dataset.mode;
            const rawUser = document.getElementById('userInput')?.value.trim() || '';
            const username = rawUser.toLowerCase();
            const password = document.getElementById('passwordInput')?.value;

            if (!username) return showToast('Please enter your username', true);
            if (!password) return showToast('Please enter your password', true);

            if (mode === 'login') {
                toggleBtnLoading('authSubmitBtn', true);
                try {
                    const res = await apiRequest('/login', {
                        method: 'POST',
                        body: JSON.stringify({ username, password })
                    });
                    handleAuthSuccess(res.access_token, res.username || username);
                } catch (err) {
                    showToast(err.message, true);
                } finally {
                    toggleBtnLoading('authSubmitBtn', false, 'Sign In to Workspace');
                }
            } else {
                const email = document.getElementById('emailInput')?.value.trim();
                const phone = document.getElementById('phoneInput')?.value.trim();
                if (!email || !phone) return showToast('Email and phone are required for signup', true);
                if (password.length < 8) return showToast('Password must be at least 8 characters', true);

                toggleBtnLoading('authSubmitBtn', true);
                try {
                    const res = await apiRequest('/register', {
                        method: 'POST',
                        body: JSON.stringify({ username, email, phone, password })
                    });
                    showToast(res.msg || 'Account created successfully!');
                    handleAuthSuccess(res.access_token, res.username || username);
                } catch (err) {
                    showToast(err.message, true);
                } finally {
                    toggleBtnLoading('authSubmitBtn', false, 'Create Free Account');
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

        // Update UPI VPA
        updateUpiVpa(username);

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
    // UPI VPA & Bank Masking Logic
    // -------------------------------------------------------------------------
    function updateUpiVpa(username) {
        const vpa = `${(username || 'user').toLowerCase()}@novapay`;
        const vpaEl = document.getElementById('userVpa');
        const qrVpa = document.getElementById('qrVpaCaption');
        if (vpaEl) vpaEl.textContent = vpa;
        if (qrVpa) qrVpa.textContent = `UPI ID: ${vpa}`;
    }

    function initUpiAndBankControls() {
        // Copy UPI VPA button
        const copyVpaBtn = document.getElementById('copyVpaBtn');
        const vpaPill = document.getElementById('vpaPill');

        const copyAction = async (e) => {
            e.stopPropagation();
            const vpa = `${(state.activeUser || 'user').toLowerCase()}@novapay`;
            try {
                await navigator.clipboard.writeText(vpa);
                showToast(`UPI ID copied: ${vpa}`);
            } catch {
                showToast(`UPI ID: ${vpa}`);
            }
        };

        copyVpaBtn?.addEventListener('click', copyAction);
        vpaPill?.addEventListener('click', copyAction);

        // Bank balance mask / unmask eye toggle
        const toggleBankEye = document.getElementById('toggleBankEye');
        toggleBankEye?.addEventListener('click', () => {
            state.isBankBalanceMasked = !state.isBankBalanceMasked;
            updateBankDisplay();
        });
    }

    function updateBankDisplay() {
        const bankEl = document.getElementById('viewBank');
        const eyeShow = document.querySelector('.bank-eye-btn .eye-show');
        const eyeHide = document.querySelector('.bank-eye-btn .eye-hide');

        if (!bankEl) return;

        if (state.isBankBalanceMasked) {
            bankEl.textContent = '₹••••••';
            if (eyeShow) eyeShow.style.display = 'none';
            if (eyeHide) eyeHide.style.display = 'block';
        } else {
            bankEl.textContent = formatINR(state.currentBankBalance);
            if (eyeShow) eyeShow.style.display = 'block';
            if (eyeHide) eyeHide.style.display = 'none';
        }
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
        // 1. Primary & Bank Balances
        const walletEl = document.getElementById('viewWallet');
        walletEl?.classList.remove('skeleton');

        const newWalletBal = Number(data.wallet_balance || 0);
        const newBankBal = Number(data.bank_balance || 0);
        const vaultsTotal = Number(data.vaults_total || 0);
        const netWorth = Number(data.net_worth || (newWalletBal + newBankBal + vaultsTotal));

        animateValue(walletEl, state.currentWalletBalance, newWalletBal);

        state.currentWalletBalance = newWalletBal;
        state.currentBankBalance = newBankBal;
        updateBankDisplay();

        // 2. Executive Summary Strip
        const nwEl = document.getElementById('viewNetWorth');
        if (nwEl) nwEl.textContent = formatINR(netWorth);

        const execWEl = document.getElementById('viewExecWallet');
        if (execWEl) execWEl.textContent = formatINR(newWalletBal);

        const execVpa = document.getElementById('execVpaText');
        if (execVpa && data.username) execVpa.textContent = `${data.username}@novapay`;

        const inAmt = Number(data.stats?.in || 0);
        const outAmt = Number(data.stats?.out || 0);
        const inEl = document.getElementById('viewInflow');
        if (inEl) inEl.textContent = `+${formatINR(inAmt)}`;

        const outEl = document.getElementById('viewOutflow');
        if (outEl) outEl.textContent = `-${formatINR(outAmt)}`;

        const historyList = data.history || [];
        const inCount = historyList.filter(t => t.type === 'CREDIT').length;
        const outCount = historyList.filter(t => t.type === 'DEBIT').length;
        const inCntEl = document.getElementById('viewInflowCount');
        if (inCntEl) inCntEl.textContent = `${inCount} transaction${inCount === 1 ? '' : 's'}`;
        const outCntEl = document.getElementById('viewOutflowCount');
        if (outCntEl) outCntEl.textContent = `${outCount} settlement${outCount === 1 ? '' : 's'}`;

        // 3. Titanium Cardholder & Controls Display
        const chName = document.getElementById('cardHolderName');
        if (chName) {
            chName.textContent = (data.username === 'priyanshu') ? 'PRIYANSHU CHAUHAN' : (data.username || 'USER').toUpperCase();
        }

        // Titanium Card state sync
        const freezeOverlay = document.getElementById('cardFrozenOverlay');
        const freezeBtn = document.getElementById('btnToggleFreeze');
        const isFrozen = !!data.wallet?.card_frozen;
        if (freezeOverlay) {
            freezeOverlay.style.display = isFrozen ? 'flex' : 'none';
        }
        if (freezeBtn) {
            freezeBtn.classList.toggle('active-freeze', isFrozen);
            freezeBtn.innerHTML = isFrozen
                ? `<span>❄️</span><span>Unfreeze Card</span>`
                : `<span>🔒</span><span>Freeze Card</span>`;
        }

        const slider = document.getElementById('sliderDailyLimit');
        const limitDisp = document.getElementById('dailyLimitDisplay');
        if (data.wallet?.daily_limit_inr) {
            if (slider) slider.value = data.wallet.daily_limit_inr;
            if (limitDisp) limitDisp.textContent = formatINR(data.wallet.daily_limit_inr);
        }

        const pBankEl = document.getElementById('primaryBankNameDisplay');
        if (pBankEl && data.wallet?.primary_bank) {
            pBankEl.textContent = `${data.wallet.primary_bank} •••• 4821`;
        }

        updateRewardsBadge();
        loadNotifications();

        // 4. UPI VPA update
        if (data.username) {
            updateUpiVpa(data.username);
        }

        // 5. Analytics & Doughnut Chart
        const txtIn = document.getElementById('txtIn');
        const txtOut = document.getElementById('txtOut');
        if (txtIn) txtIn.textContent = formatINR(inAmt);
        if (txtOut) txtOut.textContent = formatINR(outAmt);
        drawChart(inAmt, outAmt);

        // 6. Category Breakdown
        renderCategoryBreakdown(historyList);

        // 7. Dynamic User & Verified Merchant Directory
        loadDirectory();

        // 8. Smart Goal Vaults
        renderVaults(data.vaults || []);

        // 9. Nova AI Live Ledger Audit
        loadAiInsights();

        // 10. Payment Requests
        renderRequests(data.requests);

        // 11. Transactions History
        renderHistory();
    }

    // -------------------------------------------------------------------------
    // Fix ₹0.00 Chart Bug & Category Breakdown
    // -------------------------------------------------------------------------
    function drawChart(inVal, outVal) {
        const canvas = document.getElementById('chartCanvas');
        if (!canvas || typeof Chart === 'undefined') return;

        if (state.walletChart) {
            state.walletChart.destroy();
        }

        const ctx = canvas.getContext('2d');
        const isDark = document.querySelector('meta[name="color-scheme"]')?.content === 'dark';
        const centerBadge = document.getElementById('chartCenterVal');

        const hasFlow = inVal > 0 || outVal > 0;

        if (!hasFlow) {
            // Fix ₹0.00 bug: Render a single neutral slate ring with center label "No Flow"
            if (centerBadge) centerBadge.textContent = 'No Flow';

            const neutralColor = isDark ? '#27272a' : '#e4e4e7';
            state.walletChart = new Chart(ctx, {
                type: 'doughnut',
                data: {
                    datasets: [{
                        data: [1],
                        backgroundColor: [neutralColor],
                        borderWidth: 0,
                        hoverOffset: 0
                    }]
                },
                options: {
                    cutout: '76%',
                    plugins: {
                        legend: { display: false },
                        tooltip: { enabled: false }
                    },
                    maintainAspectRatio: false,
                    responsive: true
                }
            });
        } else {
            if (centerBadge) {
                const net = inVal - outVal;
                centerBadge.textContent = net >= 0 ? '+₹' : '-₹';
            }

            state.walletChart = new Chart(ctx, {
                type: 'doughnut',
                data: {
                    datasets: [{
                        data: [inVal || 0.0001, outVal || 0.0001],
                        backgroundColor: ['#10b981', '#ef4444'],
                        borderWidth: 0,
                        hoverOffset: 3
                    }]
                },
                options: {
                    cutout: '76%',
                    plugins: {
                        legend: { display: false },
                        tooltip: {
                            callbacks: {
                                label: (c) => ` ₹${Number(c.raw).toFixed(2)}`
                            }
                        }
                    },
                    maintainAspectRatio: false,
                    responsive: true
                }
            });
        }
    }

    function renderCategoryBreakdown(history) {
        const container = document.getElementById('categoryBreakdown');
        if (!container) return;

        // Tally DEBIT history by category
        const debits = history.filter(t => t.type === 'DEBIT');
        if (!debits.length) {
            container.innerHTML = `<div class="breakdown-empty">No spending history yet</div>`;
            return;
        }

        const totals = {
            'Transfer': 0,
            'Food': 0,
            'Shopping': 0,
            'Bills': 0
        };

        let grandTotal = 0;
        debits.forEach(t => {
            const cat = t.category || 'Transfer';
            const amt = Number(t.amount || 0);
            if (totals[cat] !== undefined) {
                totals[cat] += amt;
            } else {
                totals['Transfer'] += amt;
            }
            grandTotal += amt;
        });

        if (grandTotal <= 0) {
            container.innerHTML = `<div class="breakdown-empty">No spending recorded yet</div>`;
            return;
        }

        const colors = {
            'Food': '#f59e0b',
            'Shopping': '#8b5cf6',
            'Bills': '#3b82f6',
            'Transfer': '#10b981'
        };

        const sorted = Object.entries(totals)
            .filter(([_, val]) => val > 0)
            .sort((a, b) => b[1] - a[1]);

        if (!sorted.length) {
            container.innerHTML = `<div class="breakdown-empty">No spending recorded yet</div>`;
            return;
        }

        container.innerHTML = sorted.map(([cat, val]) => {
            const pct = Math.round((val / grandTotal) * 100);
            const color = colors[cat] || '#10b981';
            return `
                <div class="breakdown-item">
                    <div class="breakdown-meta">
                        <span class="breakdown-cat-name">${cat}</span>
                        <span class="breakdown-cat-vals">${formatINR(val)} &bull; <strong>${pct}%</strong></span>
                    </div>
                    <div class="breakdown-progress-track">
                        <div class="breakdown-progress-fill" style="width: ${pct}%; background: ${color};"></div>
                    </div>
                </div>
            `;
        }).join('');
    }

    // -------------------------------------------------------------------------
    // Quick Amount Pills & Recent Peers
    // -------------------------------------------------------------------------
    function initQuickAmountPills() {
        document.querySelectorAll('.amt-pill').forEach(pill => {
            pill.addEventListener('click', () => {
                const group = pill.closest('.quick-amt-pills');
                const targetId = group?.dataset.target;
                const amt = Number(pill.dataset.amt) || 0;
                if (!targetId) return;

                const input = document.getElementById(targetId);
                if (!input) return;

                const current = Number(input.value) || 0;
                input.value = current + amt;
                input.focus();
                showToast(`+${formatINR(amt)} added`);
            });
        });
    }

    async function loadDirectory() {
        try {
            const res = await apiRequest('/users/directory');
            const directory = res.directory || [];

            // 1. In Send Drawer (Recent Contacts & Verified Merchants)
            const payPeersContainer = document.getElementById('payRecentPeers');
            if (payPeersContainer) {
                payPeersContainer.innerHTML = directory.slice(0, 8).map(p => `
                    <button type="button" class="peer-chip" onclick="window.NovaApp.selectPeer('${escapeHtml(p.username)}')">
                        <span class="peer-avatar">${escapeHtml(p.avatar || p.username.substring(0, 1))}</span>
                        <span>@${escapeHtml(p.username)}</span>
                    </button>
                `).join('');
            }

            // 2. In Right Sidebar Quick Contacts
            const sideList = document.getElementById('quickContactsList');
            if (sideList) {
                sideList.innerHTML = directory.map(p => `
                    <div class="contact-row-item" onclick="window.NovaApp.selectPeer('${escapeHtml(p.username)}')">
                        <div class="contact-info">
                            <div class="contact-avatar">${escapeHtml(p.avatar || p.username.substring(0, 1))}</div>
                            <div>
                                <div class="contact-name">${escapeHtml(p.name || p.username)}</div>
                                <div class="contact-handle">@${escapeHtml(p.username.toLowerCase())} &bull; ${escapeHtml(p.category || 'UPI')}</div>
                            </div>
                        </div>
                        <button type="button" class="contact-send-btn">Send &rarr;</button>
                    </div>
                `).join('');
            }
        } catch (e) {
            console.warn('Failed to load user directory:', e);
        }
    }

    const renderRecentPeers = loadDirectory;

    function selectPeer(username) {
        togglePanel('payArea');
        const payTo = document.getElementById('payTo');
        if (payTo) {
            payTo.value = username;
            document.getElementById('payAmt')?.focus();
        }
        showToast(`Selected @${username}`);
    }

    // -------------------------------------------------------------------------
    // Simulated SMS Banner & 4-Box OTP
    // -------------------------------------------------------------------------
    function initSmsBannerAndOtpBoxes() {
        // SMS banner dismissal
        document.getElementById('smsCloseBtn')?.addEventListener('click', () => {
            const banner = document.getElementById('smsBanner');
            if (banner) banner.style.display = 'none';
        });

        // SMS auto-fill button
        document.getElementById('smsAutofillBtn')?.addEventListener('click', () => {
            if (state.lastOtpCode) {
                fillOtpBoxes(state.lastOtpCode);
                showToast('OTP auto-filled!');
                const confBtn = document.getElementById('confPayBtn');
                confBtn?.focus();
            }
        });

        // 4 Single-digit OTP input boxes
        const boxes = document.querySelectorAll('.otp-box-digit');
        boxes.forEach((box, idx) => {
            box.addEventListener('input', (e) => {
                const val = box.value.replace(/\D/g, '');
                box.value = val ? val[val.length - 1] : '';

                syncOtpToHiddenInput();

                if (box.value && idx < boxes.length - 1) {
                    boxes[idx + 1].focus();
                }
            });

            box.addEventListener('keydown', (e) => {
                if (e.key === 'Backspace' && !box.value && idx > 0) {
                    boxes[idx - 1].focus();
                }
            });

            box.addEventListener('paste', (e) => {
                e.preventDefault();
                const pasteData = (e.clipboardData || window.clipboardData).getData('text').replace(/\D/g, '');
                if (pasteData) {
                    fillOtpBoxes(pasteData);
                }
            });
        });
    }

    function fillOtpBoxes(code) {
        const clean = String(code || '').replace(/\D/g, '').slice(0, 4);
        const boxes = document.querySelectorAll('.otp-box-digit');
        boxes.forEach((b, i) => {
            b.value = clean[i] || '';
        });
        syncOtpToHiddenInput();
        if (clean.length === 4) {
            boxes[3]?.focus();
        }
    }

    function syncOtpToHiddenInput() {
        const boxes = document.querySelectorAll('.otp-box-digit');
        let full = '';
        boxes.forEach(b => { full += (b.value || ''); });
        const hidden = document.getElementById('payOtp');
        if (hidden) hidden.value = full;
    }

    function triggerSimulatedSms(code, amount) {
        state.lastOtpCode = code;
        state.lastOtpAmount = amount;

        const banner = document.getElementById('smsBanner');
        const codeSpan = document.getElementById('smsCodeVal');
        const smsBody = document.getElementById('smsBody');

        if (codeSpan) codeSpan.textContent = code;
        if (smsBody) {
            smsBody.innerHTML = `Your OTP for <strong>${formatINR(amount || 0)}</strong> transfer is <span class="sms-code-highlight">${escapeHtml(code)}</span>.`;
        }

        if (banner) {
            banner.style.display = 'block';
            clearTimeout(banner._dismissTimer);
            banner._dismissTimer = setTimeout(() => {
                banner.style.display = 'none';
            }, 12000);
        }
    }

    // -------------------------------------------------------------------------
    // Transaction History, Live Search & Receipt Modal
    // -------------------------------------------------------------------------
    function initFiltersAndSearch() {
        const filterRow = document.getElementById('filterRow');
        const searchInput = document.getElementById('txnSearch');

        filterRow?.addEventListener('click', (e) => {
            const chip = e.target.closest('.chip');
            if (!chip) return;

            filterRow.querySelectorAll('.chip').forEach(c => {
                c.setAttribute('aria-pressed', 'false');
            });
            chip.setAttribute('aria-pressed', 'true');
            state.activeFilter = chip.dataset.filter || 'all';
            renderHistory();
        });

        searchInput?.addEventListener('input', (e) => {
            state.searchQuery = e.target.value.trim().toLowerCase();
            renderHistory();
        });
    }

    function getFilteredHistory() {
        if (!state.userData?.history) return [];
        const filter = state.activeFilter;
        const query = state.searchQuery;

        return state.userData.history.filter(t => {
            // Filter match
            let matchFilter = true;
            if (filter === 'credit') matchFilter = t.type === 'CREDIT';
            else if (filter === 'debit') matchFilter = t.type === 'DEBIT';
            else if (filter !== 'all') {
                matchFilter = (t.category || '').toLowerCase() === filter.toLowerCase();
            }

            if (!matchFilter) return false;

            // Search query match
            if (query) {
                const hay = `${t.desc || ''} ${t.category || ''} ${t.txn_id || ''} ${t.counterparty || ''} ${t.note || ''}`.toLowerCase();
                return hay.includes(query);
            }

            return true;
        });
    }

    function renderHistory() {
        const container = document.getElementById('historyList');
        if (!container) return;

        const txns = getFilteredHistory();

        if (!txns.length) {
            container.innerHTML = `
                <div class="empty-state">
                    <p>No transactions found matching your criteria.</p>
                </div>
            `;
            return;
        }

        let html = '';
        txns.forEach(t => {
            const isCredit = t.type === 'CREDIT';
            const cat = t.category || (t.kind === 'LOAD' ? 'Bank Load' : 'Transfer');
            const iconSvg = isCredit
                ? `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"></path><polyline points="7 10 12 15 17 10"></polyline><line x1="12" y1="15" x2="12" y2="3"></line></svg>`
                : `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><line x1="22" y1="2" x2="11" y2="13"></line><polygon points="22 2 15 22 11 13 2 9 22 2"></polygon></svg>`;

            const dtDisplay = t.timestamp ? formatTimestamp(t.timestamp) : 'Recent';
            const noteHtml = t.note ? `<div class="note-text">"${escapeHtml(t.note)}"</div>` : '';

            // Clickable item opening receipt modal
            html += `
                <div class="history-item" onclick="window.NovaApp.openReceipt('${escapeHtml(t.txn_id)}')">
                    <div class="history-left">
                        <div class="history-icon ${isCredit ? 'in' : 'out'}">${iconSvg}</div>
                        <div>
                            <div class="desc-text">
                                ${escapeHtml(t.desc)}
                                <span class="category-pill">${escapeHtml(cat)}</span>
                            </div>
                            <div class="date-text">${dtDisplay} &bull; <span class="meta-mono">${escapeHtml(t.txn_id)}</span></div>
                            ${noteHtml}
                        </div>
                    </div>
                    <div class="amt-text ${isCredit ? 'credit' : 'debit'}">
                        ${isCredit ? '+' : '-'}${formatINR(t.amount)}
                    </div>
                </div>
            `;
        });

        container.innerHTML = html;
    }

    // -------------------------------------------------------------------------
    // Receipt Modal & Download
    // -------------------------------------------------------------------------
    
    // -------------------------------------------------------------------------
    // Smart Goal Savings Vaults (Savings Lockers)
    // -------------------------------------------------------------------------
    async function loadVaults() {
        try {
            const res = await apiRequest('/vaults');
            renderVaults(res.vaults || []);
        } catch (e) {
            console.warn('Failed to load vaults:', e);
        }
    }

    function renderVaults(vaults) {
        const grid = document.getElementById('vaultsGrid');
        const badge = document.getElementById('vaultCountBadge');
        if (!grid) return;
        if (badge) badge.textContent = `${vaults.length} Active Locker${vaults.length === 1 ? '' : 's'}`;

        if (!vaults.length) {
            grid.innerHTML = '<div style="grid-column: 1/-1; padding: 16px; color: var(--text-muted); font-size: 13px;">No active savings vaults.</div>';
            return;
        }

        grid.innerHTML = vaults.map(v => `
            <div class="vault-card" data-vault-id="${v.id}">
                <div class="vault-card-head">
                    <span class="vault-title">${escapeHtml(v.name)}</span>
                    <span class="vault-pct">${v.progress_pct}%</span>
                </div>
                <div class="vault-progress-track">
                    <div class="vault-progress-fill" style="width: ${v.progress_pct}%;"></div>
                </div>
                <div class="vault-amounts-row">
                    <div>
                        <span style="font-size: 10px; color: var(--text-muted); display: block;">LOCKED</span>
                        <span class="vault-locked-val">${formatINR(v.balance)}</span>
                    </div>
                    <div style="text-align: right;">
                        <span style="font-size: 10px; color: var(--text-muted); display: block;">TARGET</span>
                        <span class="vault-target-val">${formatINR(v.target)}</span>
                    </div>
                </div>
                <div class="vault-actions-row">
                    <button type="button" class="vault-btn-dep" onclick="window.NovaApp.openVaultModal(${v.id}, 'deposit', '${escapeHtml(v.name)}', ${v.balance}, ${v.target})">+ Deposit</button>
                    <button type="button" class="vault-btn-wdr" onclick="window.NovaApp.openVaultModal(${v.id}, 'withdraw', '${escapeHtml(v.name)}', ${v.balance}, ${v.target})">&minus; Withdraw</button>
                </div>
            </div>
        `).join('');
    }

    function openVaultModal(vaultId, action, name, balance, target) {
        const modal = document.getElementById('vaultModal');
        const titleEl = document.getElementById('vaultModalTitle');
        const subEl = document.getElementById('vaultModalSub');
        const nameEl = document.getElementById('vaultModalName');
        const curEl = document.getElementById('vaultModalCurrent');
        const tgtEl = document.getElementById('vaultModalTarget');
        const actTypeInput = document.getElementById('vaultActionType');
        const targetIdInput = document.getElementById('vaultTargetId');
        const amtInput = document.getElementById('vaultAmountInput');
        const submitBtn = document.getElementById('vaultSubmitBtn');

        if (!modal) return;
        actTypeInput.value = action;
        targetIdInput.value = vaultId;
        if (nameEl) nameEl.textContent = name;
        if (curEl) curEl.textContent = formatINR(balance);
        if (tgtEl) tgtEl.textContent = formatINR(target);
        if (amtInput) amtInput.value = '';

        if (action === 'deposit') {
            if (titleEl) titleEl.textContent = `Deposit to ${name}`;
            if (subEl) subEl.textContent = 'Lock spendable wallet balance into this savings goal';
            if (submitBtn) submitBtn.textContent = 'Confirm Deposit';
        } else {
            if (titleEl) titleEl.textContent = `Withdraw from ${name}`;
            if (subEl) subEl.textContent = 'Release locked funds back into your liquid spendable wallet';
            if (submitBtn) submitBtn.textContent = 'Confirm Withdrawal';
        }

        if (typeof modal.showModal === 'function') {
            modal.showModal();
        } else {
            modal.style.display = 'flex';
        }
    }

    function initVaults() {
        const form = document.getElementById('vaultForm');
        const modal = document.getElementById('vaultModal');
        const closeBtn = document.getElementById('vaultCloseBtn');
        const cancelBtn = document.getElementById('vaultCancelBtn');

        closeBtn?.addEventListener('click', () => modal?.close());
        cancelBtn?.addEventListener('click', () => modal?.close());

        form?.addEventListener('submit', async (e) => {
            e.preventDefault();
            const action = document.getElementById('vaultActionType')?.value;
            const vaultId = document.getElementById('vaultTargetId')?.value;
            const amt = Number(document.getElementById('vaultAmountInput')?.value || 0);

            if (!amt || amt <= 0) return showToast('Please enter a valid amount in ₹', true);

            toggleBtnLoading('vaultSubmitBtn', true);
            try {
                const endpoint = action === 'deposit' ? '/vaults/deposit' : '/vaults/withdraw';
                const res = await apiRequest(endpoint, {
                    method: 'POST',
                    body: JSON.stringify({ vault_id: vaultId, amount: amt })
                });
                modal?.close();
                showToast(res.msg);
                if (res.user) {
                    state.userData = res.user;
                    renderDashboard(res.user);
                } else {
                    await refreshUserData();
                }
            } catch (err) {
                showToast(err.message, true);
            } finally {
                toggleBtnLoading('vaultSubmitBtn', false, action === 'deposit' ? 'Confirm Deposit' : 'Confirm Withdrawal');
            }
        });
    }

    // -------------------------------------------------------------------------
    // Nova AI Financial Copilot (Live Ledger Audit & Interactive Chat)
    // -------------------------------------------------------------------------
    async function loadAiInsights() {
        const auditList = document.getElementById('aiAuditList');
        const timestamp = document.getElementById('auditTimestamp');
        if (!auditList) return;

        try {
            const res = await apiRequest('/ai/insights');
            const insights = res.insights || [];
            if (insights.length) {
                auditList.innerHTML = insights.map(pt => `<li>${escapeHtml(pt)}</li>`).join('');
            }
            if (timestamp) {
                timestamp.textContent = new Date().toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit' });
            }
        } catch (e) {
            console.warn('AI insights failed:', e);
        }
    }

    function initNovaAi() {
        const chatForm = document.getElementById('aiChatForm');
        const chatInput = document.getElementById('aiChatInput');
        const chatStream = document.getElementById('aiChatStream');
        const navAskBtn = document.getElementById('navAskAiBtn');

        navAskBtn?.addEventListener('click', () => {
            const section = document.getElementById('novaAiSection');
            section?.scrollIntoView({ behavior: 'smooth', block: 'start' });
            chatInput?.focus();
        });

        // 4 1-click analysis prompt buttons
        document.querySelectorAll('.ai-prompt-btn').forEach(btn => {
            btn.addEventListener('click', () => {
                const query = btn.dataset.query;
                if (query) askNovaAi(query);
            });
        });

        chatForm?.addEventListener('submit', (e) => {
            e.preventDefault();
            const query = chatInput?.value?.trim();
            if (!query) return;
            chatInput.value = '';
            askNovaAi(query);
        });

        async function askNovaAi(query) {
            if (!chatStream) return;

            // Render user bubble
            const userBubble = document.createElement('div');
            userBubble.className = 'ai-chat-msg user';
            userBubble.textContent = query;
            chatStream.appendChild(userBubble);

            // Render thinking bubble
            const aiBubble = document.createElement('div');
            aiBubble.className = 'ai-chat-msg ai';
            aiBubble.innerHTML = '<em>Thinking with live ledger context...</em>';
            chatStream.appendChild(aiBubble);
            chatStream.scrollTop = chatStream.scrollHeight;

            try {
                const res = await apiRequest('/ai/ask', {
                    method: 'POST',
                    body: JSON.stringify({ query })
                });
                aiBubble.textContent = res.answer || 'Analysis complete.';
            } catch (err) {
                aiBubble.textContent = `Analysis error: ${err.message}`;
            }
            chatStream.scrollTop = chatStream.scrollHeight;
        }
    }

    function initReceiptModal() {
        const modal = document.getElementById('receiptModal');
        const copyBtn = document.getElementById('copyTxnIdBtn');
        const downloadBtn = document.getElementById('downloadReceiptBtn');

        copyBtn?.addEventListener('click', async () => {
            const txt = document.getElementById('receiptTxnIdText')?.textContent;
            if (txt) {
                try {
                    await navigator.clipboard.writeText(txt);
                    showToast(`Copied TXN ID: ${txt}`);
                } catch {
                    showToast(txt);
                }
            }
        });

        downloadBtn?.addEventListener('click', () => {
            const printWin = window.open('', '_blank', 'width=500,height=700');
            if (!printWin) return showToast('Please allow popups to download receipt', true);

            const amt = document.getElementById('receiptAmount')?.textContent || '₹0.00';
            const desc = document.getElementById('receiptDesc')?.textContent || 'Payment';
            const txnId = document.getElementById('receiptTxnIdText')?.textContent || '';
            const time = document.getElementById('receiptTime')?.textContent || '';
            const cat = document.getElementById('receiptCategory')?.textContent || '';
            const party = document.getElementById('receiptCounterparty')?.textContent || '';
            const note = document.getElementById('receiptNote')?.textContent || '';

            printWin.document.write(`
                <!DOCTYPE html>
                <html>
                <head>
                    <title>Receipt - ${escapeHtml(txnId)}</title>
                    <style>
                        body { font-family: 'Plus Jakarta Sans', system-ui, sans-serif; padding: 30px; color: #0f172a; text-align: center; }
                        .logo { font-size: 20px; font-weight: 800; color: #10b981; margin-bottom: 4px; }
                        .badge { background: #ecfdf5; color: #047857; padding: 4px 10px; border-radius: 20px; font-size: 11px; font-weight: 800; display: inline-block; margin-bottom: 20px; }
                        .amt { font-size: 32px; font-weight: 800; margin-bottom: 4px; }
                        .desc { font-size: 14px; color: #64748b; margin-bottom: 24px; }
                        table { width: 100%; text-align: left; border-collapse: collapse; margin-bottom: 24px; }
                        td { padding: 10px 0; border-bottom: 1px solid #e2e8f0; font-size: 13px; }
                        .label { color: #64748b; font-weight: 600; }
                        .val { text-align: right; font-weight: 700; color: #0f172a; }
                        .mono { font-family: monospace; }
                        .foot { font-size: 11px; color: #94a3b8; margin-top: 20px; }
                    </style>
                </head>
                <body>
                    <div class="logo">NovaWallet</div>
                    <div class="badge">COMPLETED &bull; INSTANT UPI</div>
                    <div class="amt">${escapeHtml(amt)}</div>
                    <div class="desc">${escapeHtml(desc)}</div>
                    <table>
                        <tr><td class="label">Reference ID</td><td class="val mono">${escapeHtml(txnId)}</td></tr>
                        <tr><td class="label">Date & Time</td><td class="val">${escapeHtml(time)}</td></tr>
                        <tr><td class="label">Category</td><td class="val">${escapeHtml(cat)}</td></tr>
                        <tr><td class="label">Counterparty</td><td class="val">${escapeHtml(party)}</td></tr>
                        ${note ? `<tr><td class="label">Note</td><td class="val">${escapeHtml(note)}</td></tr>` : ''}
                    </table>
                    <div class="foot">Generated by NovaWallet Core Gateway. Authorized & Encrypted.</div>
                    <script>window.onload = () => window.print();</script>
                </body>
                </html>
            `);
            printWin.document.close();
        });
    }

    function openReceipt(txnId) {
        const txns = state.userData?.history || [];
        const t = txns.find(item => item.txn_id === txnId);
        if (!t) return;

        const modal = document.getElementById('receiptModal');
        if (!modal) return;

        const isCredit = t.type === 'CREDIT';
        const sign = isCredit ? '+' : '-';

        document.getElementById('receiptAmount').textContent = `${sign}${formatINR(t.amount)}`;
        document.getElementById('receiptAmount').style.color = isCredit ? '#10b981' : 'inherit';
        document.getElementById('receiptDesc').textContent = t.desc || 'UPI Transfer';
        document.getElementById('receiptTxnIdText').textContent = t.txn_id;
        document.getElementById('receiptTime').textContent = t.timestamp ? formatTimestamp(t.timestamp) : 'Recent';
        document.getElementById('receiptCategory').textContent = t.category || 'Transfer';
        document.getElementById('receiptCounterparty').textContent = t.counterparty ? `@${t.counterparty}` : (t.kind === 'LOAD' ? 'HDFC Bank' : 'NovaWallet');

        const noteRow = document.getElementById('receiptNoteRow');
        const noteVal = document.getElementById('receiptNote');
        if (t.note && noteRow && noteVal) {
            noteRow.style.display = 'flex';
            noteVal.textContent = t.note;
        } else if (noteRow) {
            noteRow.style.display = 'none';
        }

        modal.showModal();
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
        document.getElementById('exportCsvBtn')?.addEventListener('click', exportCSV);
        document.getElementById('exportPdfBtn')?.addEventListener('click', exportPDF);
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

        const printWindow = window.open('', '_blank', 'width=800,height=900');
        if (!printWindow) {
            return showToast('Popup blocked! Please allow popups for statement generation.', true);
        }

        const dateStr = new Date().toLocaleDateString('en-IN', {
            year: 'numeric', month: 'short', day: 'numeric'
        });

        const rowsHtml = txns.map(t => `
            <tr style="border-bottom: 1px solid #e2e8f0;">
                <td style="padding: 10px; font-size: 12px; font-family: monospace;">${escapeHtml(t.txn_id)}</td>
                <td style="padding: 10px; font-size: 13px;">${escapeHtml(t.timestamp ? formatTimestamp(t.timestamp) : '-')}</td>
                <td style="padding: 10px; font-size: 13px;">${escapeHtml(t.desc)}</td>
                <td style="padding: 10px; font-size: 13px;"><span style="background: #f1f5f9; padding: 2px 6px; border-radius: 4px; font-size: 11px;">${escapeHtml(t.category)}</span></td>
                <td style="padding: 10px; font-size: 13px; font-weight: bold; text-align: right; color: ${t.type === 'CREDIT' ? '#10b981' : '#0f172a'};">
                    ${t.type === 'CREDIT' ? '+' : '-'}${formatINR(t.amount)}
                </td>
            </tr>
        `).join('');

        printWindow.document.write(`
            <!DOCTYPE html>
            <html>
            <head>
                <title>NovaWallet Account Statement - ${escapeHtml(state.activeUser)}</title>
                <style>
                    body { font-family: 'Plus Jakarta Sans', system-ui, sans-serif; padding: 40px; color: #0f172a; }
                    .header { display: flex; justify-content: space-between; align-items: center; border-bottom: 3px solid #10b981; padding-bottom: 20px; margin-bottom: 30px; }
                    .brand { font-size: 26px; font-weight: 800; color: #10b981; }
                    .meta { text-align: right; font-size: 13px; color: #64748b; }
                    .summary { display: grid; grid-template-columns: 1fr 1fr 1fr; gap: 20px; background: #ecfdf5; padding: 18px; border-radius: 12px; margin-bottom: 30px; }
                    .card { font-size: 12px; color: #065f46; font-weight: 600; }
                    .card .val { font-size: 20px; font-weight: 800; color: #047857; margin-top: 4px; }
                    table { width: 100%; border-collapse: collapse; text-align: left; }
                    th { padding: 10px; background: #f8fafc; font-size: 12px; text-transform: uppercase; color: #64748b; border-bottom: 2px solid #e2e8f0; }
                    @media print { body { padding: 0; } }
                </style>
            </head>
            <body>
                <div class="header">
                    <div>
                        <div class="brand">NovaWallet</div>
                        <div style="font-size: 14px; color: #64748b; font-weight: 600;">Official Digital Account Statement</div>
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

                <div style="margin-top: 40px; font-size: 11px; color: #94a3b8; text-align: center;">
                    This is a certified digital statement verified by NovaWallet Atomic Transaction Engine.
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
                incomingList.innerHTML = `<p style="font-size:12.5px;color:var(--text-faint);padding:6px 0;">No incoming payment requests.</p>`;
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
                            <input type="text" id="otpInput_${r.request_id}" maxlength="4" placeholder="4-digit OTP" inputmode="numeric">
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
                                <button type="button" class="btn-link" onclick="window.NovaApp.cancelRequest('${r.request_id}')" style="background:none;border:none;color:var(--danger);font-size:11px;font-weight:700;cursor:pointer;">Cancel Request</button>
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

            if (res.demo_otp) {
                triggerSimulatedSms(res.demo_otp, res.amount);
            }

            showToast('Check notification banner for OTP code!');
            const card = document.getElementById(`reqCard_${requestId}`);
            if (card) {
                card.classList.add('otp-open');
                const inp = document.getElementById(`otpInput_${requestId}`);
                if (inp) {
                    if (res.demo_otp) inp.value = res.demo_otp;
                    inp.focus();
                }
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
                playSuccessChime();
                launchConfetti();
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

                if (res.demo_otp) {
                    triggerSimulatedSms(res.demo_otp, amt);
                }

                showToast('Security OTP issued! Check incoming notification banner.');
                document.getElementById('payStep1').style.display = 'none';
                document.getElementById('payStep2').style.display = 'block';

                // Clear OTP digit boxes and focus first
                const firstBox = document.querySelector('.otp-box-digit[data-idx="0"]');
                firstBox?.focus();
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

            if (!otp || otp.length < 4) return showToast('Please enter the 4-digit security code', true);

            toggleBtnLoading('confPayBtn', true);
            try {
                const res = await apiRequest('/confirm_pay', {
                    method: 'POST',
                    body: JSON.stringify({ to, amount: amt, category, otp })
                });
                showToast(res.msg || 'Transfer successful!');
                playSuccessChime();
                launchConfetti();
                document.getElementById('payStep2').style.display = 'none';
                document.getElementById('payStep1').style.display = 'block';
                document.getElementById('payTo').value = '';
                document.getElementById('payAmt').value = '';
                document.getElementById('payOtp').value = '';
                document.querySelectorAll('.otp-box-digit').forEach(b => { b.value = ''; });
                togglePanel('payArea');
                fetchUserData();

                if (res.scratch_card_reward) {
                    setTimeout(() => {
                        showToast(`🎁 Surprise Scratch Card Unlocked! Check rewards.`);
                        updateRewardsBadge();
                    }, 1000);
                }

                // Open receipt modal for instant gratification!
                if (res.txn_id) {
                    setTimeout(() => openReceipt(res.txn_id), 400);
                }
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
        if (!modal) return;

        const username = state.activeUser || 'priyanshu';
        const displayName = (username === 'priyanshu') ? 'Priyanshu Chauhan' : username;
        const vpaDisplay = document.getElementById('qrVpaDisplay');
        if (vpaDisplay) vpaDisplay.textContent = `${username}@novapay`;

        const amtInput = document.getElementById('qrAmountInput');
        if (amtInput) amtInput.value = '';

        function renderQrCode(amt) {
            const container = document.getElementById('qrCodeTarget');
            const uriPreview = document.getElementById('qrUriPreview');
            if (!container) return;

            let uri = `upi://pay?pa=${encodeURIComponent(username)}@novapay&pn=${encodeURIComponent(displayName)}&cu=INR`;
            if (amt && Number(amt) > 0) {
                uri += `&am=${encodeURIComponent(Number(amt).toFixed(2))}`;
            }

            if (uriPreview) uriPreview.textContent = uri;
            container.innerHTML = '';

            if (typeof QRCode !== 'undefined') {
                new QRCode(container, {
                    text: uri,
                    width: 200,
                    height: 200,
                    colorDark: '#090d16',
                    colorLight: '#ffffff',
                    correctLevel: QRCode.CorrectLevel.M
                });
            } else {
                const img = document.createElement('img');
                img.src = `https://api.qrserver.com/v1/create-qr-code/?size=200x200&data=${encodeURIComponent(uri)}&color=09090b&bgcolor=ffffff`;
                container.appendChild(img);
            }
        }

        renderQrCode();

        if (amtInput) {
            amtInput.oninput = (e) => renderQrCode(e.target.value);
        }

        const downloadBtn = document.getElementById('downloadQrBtn');
        if (downloadBtn) {
            downloadBtn.onclick = () => {
                const container = document.getElementById('qrCodeTarget');
                const canvas = container?.querySelector('canvas');
                const img = container?.querySelector('img');
                const src = canvas ? canvas.toDataURL('image/png') : img?.src;
                if (!src) return showToast('QR not ready for download', true);

                const link = document.createElement('a');
                link.download = `NovaWallet_UPI_QR_${username}.png`;
                link.href = src;
                link.click();
                showToast('QR sticker downloaded!');
            };
        }

        const copyUriBtn = document.getElementById('copyQrUriBtn');
        if (copyUriBtn) {
            copyUriBtn.onclick = () => {
                const uri = document.getElementById('qrUriPreview')?.textContent || '';
                navigator.clipboard.writeText(uri).then(() => showToast('UPI link copied!'));
            };
        }

        if (typeof modal.showModal === 'function') {
            modal.showModal();
        } else {
            modal.style.display = 'flex';
        }
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
    // Split Bill Engine
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
    // Dialog Fallback for Light-Dismiss
    // -------------------------------------------------------------------------
    function initDialogLightDismissFallbacks() {
        document.querySelectorAll('dialog.modal').forEach(dialog => {
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
        });
    }


    // -------------------------------------------------------------------------
    // Audio Synthesis Engine (Google Pay / CRED Acoustic Feedback)
    // -------------------------------------------------------------------------
    let audioCtx = null;
    function getAudioContext() {
        if (!audioCtx) {
            const AudioContextClass = window.AudioContext || window.webkitAudioContext;
            if (AudioContextClass) {
                audioCtx = new AudioContextClass();
            }
        }
        if (audioCtx && audioCtx.state === 'suspended') {
            audioCtx.resume();
        }
        return audioCtx;
    }

    function playSuccessChime() {
        try {
            const ctx = getAudioContext();
            if (!ctx) return;
            const now = ctx.currentTime;

            // Dual tone harmonic chord: C5 (523.25Hz) + E5 (659.25Hz) -> G5 (783.99Hz)
            const osc1 = ctx.createOscillator();
            const osc2 = ctx.createOscillator();
            const gain1 = ctx.createGain();
            const gain2 = ctx.createGain();

            osc1.type = 'sine';
            osc1.frequency.setValueAtTime(523.25, now);
            osc1.frequency.exponentialRampToValueAtTime(783.99, now + 0.15);

            gain1.gain.setValueAtTime(0.2, now);
            gain1.gain.exponentialRampToValueAtTime(0.001, now + 0.7);

            osc1.connect(gain1);
            gain1.connect(ctx.destination);

            osc2.type = 'triangle';
            osc2.frequency.setValueAtTime(659.25, now + 0.1);
            osc2.frequency.exponentialRampToValueAtTime(1046.50, now + 0.28);

            gain2.gain.setValueAtTime(0.15, now + 0.1);
            gain2.gain.exponentialRampToValueAtTime(0.001, now + 0.9);

            osc2.connect(gain2);
            gain2.connect(ctx.destination);

            osc1.start(now);
            osc1.stop(now + 0.7);
            osc2.start(now + 0.1);
            osc2.stop(now + 0.9);
        } catch (e) {
            console.debug('Audio feedback unavailable:', e);
        }
    }

    function playKeypadClick() {
        try {
            const ctx = getAudioContext();
            if (!ctx) return;
            const now = ctx.currentTime;
            const osc = ctx.createOscillator();
            const gain = ctx.createGain();
            osc.type = 'sine';
            osc.frequency.setValueAtTime(1200, now);
            gain.gain.setValueAtTime(0.06, now);
            gain.gain.exponentialRampToValueAtTime(0.001, now + 0.04);
            osc.connect(gain);
            gain.connect(ctx.destination);
            osc.start(now);
            osc.stop(now + 0.04);
        } catch (e) {}
    }

    // -------------------------------------------------------------------------
    // Canvas Confetti Celebration Physics
    // -------------------------------------------------------------------------
    function launchConfetti() {
        let canvas = document.getElementById('confettiCanvas');
        if (!canvas) {
            canvas = document.createElement('canvas');
            canvas.id = 'confettiCanvas';
            document.body.appendChild(canvas);
        }

        canvas.width = window.innerWidth;
        canvas.height = window.innerHeight;
        const ctx = canvas.getContext('2d');
        if (!ctx) return;

        const colors = ['#10b981', '#3b82f6', '#f59e0b', '#ec4899', '#8b5cf6', '#34d399', '#ffffff'];
        const particles = [];
        const count = 100;

        for (let i = 0; i < count; i++) {
            particles.push({
                x: canvas.width / 2 + (Math.random() - 0.5) * 200,
                y: canvas.height * 0.45,
                w: Math.random() * 8 + 4,
                h: Math.random() * 6 + 3,
                vx: (Math.random() - 0.5) * 16,
                vy: (Math.random() - 1.2) * 18,
                rot: Math.random() * 360,
                rotSpeed: (Math.random() - 0.5) * 12,
                color: colors[Math.floor(Math.random() * colors.length)],
                alpha: 1,
                decay: Math.random() * 0.015 + 0.008,
                gravity: 0.35
            });
        }

        let animId;
        function update() {
            ctx.clearRect(0, 0, canvas.width, canvas.height);
            let active = 0;

            for (const p of particles) {
                if (p.alpha <= 0) continue;
                active++;
                p.x += p.vx;
                p.y += p.vy;
                p.vy += p.gravity;
                p.rot += p.rotSpeed;
                p.alpha = Math.max(0, p.alpha - p.decay);

                ctx.save();
                ctx.globalAlpha = p.alpha;
                ctx.translate(p.x, p.y);
                ctx.rotate((p.rot * Math.PI) / 180);
                ctx.fillStyle = p.color;
                ctx.fillRect(-p.w / 2, -p.h / 2, p.w, p.h);
                ctx.restore();
            }

            if (active > 0) {
                animId = requestAnimationFrame(update);
            } else {
                ctx.clearRect(0, 0, canvas.width, canvas.height);
                cancelAnimationFrame(animId);
            }
        }
        update();
    }

    // -------------------------------------------------------------------------
    // NPCI UPI 2.0 MPIN Bottom Sheet / Modal
    // -------------------------------------------------------------------------
    let mpinState = {
        currentPin: '',
        onSuccess: null,
        onCancel: null
    };

    function openMpinSheet({ receiver, amount, bank, onSuccess, onCancel }) {
        mpinState.currentPin = '';
        mpinState.onSuccess = onSuccess;
        mpinState.onCancel = onCancel;

        const modal = document.getElementById('mpinModal');
        if (!modal) {
            // Fallback if dialog missing
            if (onSuccess) onSuccess('1234');
            return;
        }

        const recvEl = document.getElementById('mpinReceiverDisplay');
        const amtEl = document.getElementById('mpinAmountDisplay');
        const bankEl = document.getElementById('mpinBankDisplay');
        const errEl = document.getElementById('mpinError');

        if (recvEl) recvEl.textContent = receiver || 'Merchant';
        if (amtEl) amtEl.textContent = typeof amount === 'number' ? formatINR(amount) : amount;
        if (bankEl) bankEl.textContent = bank || (state.userData?.wallet?.primary_bank ? `${state.userData.wallet.primary_bank} •••• 4821` : 'HDFC Bank •••• 4821');
        if (errEl) errEl.textContent = '';

        updateMpinDots();
        modal.showModal();
    }

    function updateMpinDots() {
        const dots = document.querySelectorAll('.pin-dot');
        dots.forEach((dot, idx) => {
            if (idx < mpinState.currentPin.length) {
                dot.classList.add('filled');
            } else {
                dot.classList.remove('filled');
            }
        });
    }

    function initMpinModal() {
        const modal = document.getElementById('mpinModal');
        const closeBtn = document.getElementById('closeMpinModalBtn');
        const backspaceBtn = document.getElementById('mpinBackspaceBtn');
        const submitBtn = document.getElementById('mpinSubmitBtn');
        const errEl = document.getElementById('mpinError');

        closeBtn?.addEventListener('click', () => {
            modal?.close();
            if (mpinState.onCancel) mpinState.onCancel();
        });

        // Numeric keypad buttons
        document.querySelectorAll('.mpin-num-btn').forEach(btn => {
            btn.addEventListener('click', () => {
                const num = btn.dataset.num;
                if (!num || mpinState.currentPin.length >= 4) return;
                playKeypadClick();
                mpinState.currentPin += num;
                updateMpinDots();
                if (errEl) errEl.textContent = '';

                if (mpinState.currentPin.length === 4) {
                    setTimeout(() => handleMpinSubmit(), 120);
                }
            });
        });

        backspaceBtn?.addEventListener('click', () => {
            if (mpinState.currentPin.length > 0) {
                playKeypadClick();
                mpinState.currentPin = mpinState.currentPin.slice(0, -1);
                updateMpinDots();
                if (errEl) errEl.textContent = '';
            }
        });

        submitBtn?.addEventListener('click', handleMpinSubmit);

        function handleMpinSubmit() {
            if (mpinState.currentPin.length < 4) {
                if (errEl) errEl.textContent = 'Enter complete 4-digit UPI PIN';
                return;
            }

            // Demo default MPIN is 1234
            if (mpinState.currentPin !== '1234') {
                playKeypadClick();
                if (errEl) errEl.textContent = 'Incorrect UPI PIN. (Demo MPIN: 1234)';
                const dotsRow = document.querySelector('.mpin-dots-row');
                if (dotsRow) {
                    dotsRow.style.transform = 'translateX(-8px)';
                    setTimeout(() => { dotsRow.style.transform = 'translateX(8px)'; }, 80);
                    setTimeout(() => { dotsRow.style.transform = 'translateX(0)'; }, 160);
                }
                mpinState.currentPin = '';
                updateMpinDots();
                return;
            }

            modal?.close();
            if (mpinState.onSuccess) {
                mpinState.onSuccess(mpinState.currentPin);
            }
        }
    }

    // -------------------------------------------------------------------------
    // BBPS Bharat BillPay Utility Engine
    // -------------------------------------------------------------------------
    let currentFetchedBill = null;

    function initBbpsBills() {
        const actBillsBtn = document.getElementById('actBills');
        const billsPanel = document.getElementById('billsArea');
        const fetchBtn = document.getElementById('btnFetchBill');
        const consumerInput = document.getElementById('billConsumerInput');
        const resultCard = document.getElementById('billFetchResult');
        const payConfirmBtn = document.getElementById('btnPayBillConfirm');
        const catLabel = document.getElementById('billCatLabel');

        actBillsBtn?.addEventListener('click', () => {
            togglePanel('billsArea');
        });

        // Category selection
        let activeCategory = 'electricity';
        const placeholders = {
            electricity: 'e.g. CA No. 102938475 (BSES / Tata Power)',
            broadband: 'e.g. Acc No. 0804829102 (Airtel Xstream / ACT)',
            mobile: 'e.g. 10-digit Mobile No. (Jio / Vi / Airtel)',
            fastag: 'e.g. Vehicle Reg No. DL01AB1234',
            creditcard: 'e.g. Last 4 Digits of Card',
            dth: 'e.g. Subscriber ID 3019283748'
        };

        document.querySelectorAll('.bill-cat-btn').forEach(btn => {
            btn.addEventListener('click', () => {
                document.querySelectorAll('.bill-cat-btn').forEach(b => b.classList.remove('active'));
                btn.classList.add('active');
                activeCategory = btn.dataset.cat || 'electricity';
                if (catLabel) catLabel.textContent = btn.textContent.trim();
                if (consumerInput) {
                    consumerInput.placeholder = placeholders[activeCategory] || 'Enter Consumer ID';
                    consumerInput.value = '';
                    consumerInput.focus();
                }
                if (resultCard) resultCard.style.display = 'none';
                currentFetchedBill = null;
            });
        });

        // Fetch Bill Action
        fetchBtn?.addEventListener('click', async () => {
            const idVal = consumerInput?.value.trim();
            if (!idVal) {
                return showToast('Please enter consumer ID or account number', true);
            }

            toggleBtnLoading('btnFetchBill', true);
            try {
                const res = await apiRequest('/bills/fetch', {
                    method: 'POST',
                    body: JSON.stringify({ category: activeCategory, consumer_id: idVal })
                });

                currentFetchedBill = res.bill;
                const billerEl = document.getElementById('billBillerName');
                const nameEl = document.getElementById('billConsumerName');
                const dueEl = document.getElementById('billDueDate');
                const amtEl = document.getElementById('billAmountVal');

                if (billerEl) billerEl.textContent = res.bill.biller;
                if (nameEl) nameEl.textContent = `${res.bill.consumer_name} (${res.bill.consumer_id})`;
                if (dueEl) dueEl.textContent = `Due by ${res.bill.due_date}`;
                if (amtEl) amtEl.textContent = formatINR(res.bill.amount);

                if (resultCard) {
                    resultCard.style.display = 'block';
                    resultCard.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
                }
                showToast('BBPS bill fetched successfully!');
            } catch (err) {
                showToast(err.message, true);
            } finally {
                toggleBtnLoading('btnFetchBill', false, 'Fetch Bill');
            }
        });

        // Pay Bill with NPCI MPIN Confirmation
        payConfirmBtn?.addEventListener('click', () => {
            if (!currentFetchedBill) return;

            openMpinSheet({
                receiver: currentFetchedBill.biller,
                amount: currentFetchedBill.amount,
                bank: state.userData?.wallet?.primary_bank ? `${state.userData.wallet.primary_bank} •••• 4821` : 'HDFC Bank •••• 4821',
                onSuccess: async (mpin) => {
                    toggleBtnLoading('btnPayBillConfirm', true);
                    try {
                        const payRes = await apiRequest('/bills/pay', {
                            method: 'POST',
                            body: JSON.stringify({
                                bill_id: currentFetchedBill.bill_id,
                                mpin: mpin
                            })
                        });

                        playSuccessChime();
                        launchConfetti();
                        showToast(payRes.msg || 'Bill payment successful!');

                        if (resultCard) resultCard.style.display = 'none';
                        if (consumerInput) consumerInput.value = '';
                        currentFetchedBill = null;

                        // Refresh wallet balances
                        fetchUserData();

                        // Open Google Pay style receipt
                        if (payRes.txn_id) {
                            openShareReceipt({
                                txn_id: payRes.txn_id,
                                amount: payRes.amount,
                                receiver: payRes.biller,
                                bank: state.userData?.wallet?.primary_bank ? `${state.userData.wallet.primary_bank} •••• 4821` : 'HDFC Bank •••• 4821',
                                timestamp: new Date().toLocaleString('en-IN')
                            });
                        }

                        if (payRes.reward) {
                            setTimeout(() => {
                                showToast(`🎁 Mystery Scratch Card Unlocked (up to ₹${payRes.reward.max_cashback})!`);
                                updateRewardsBadge();
                            }, 1200);
                        }
                    } catch (err) {
                        showToast(err.message, true);
                    } finally {
                        toggleBtnLoading('btnPayBillConfirm', false, 'Pay via Nova UPI');
                    }
                }
            });
        });
    }

    // -------------------------------------------------------------------------
    // CRED-style Mystery Scratch Cards & Rewards Hub
    // -------------------------------------------------------------------------
    let activeScratchingReward = null;

    async function updateRewardsBadge() {
        try {
            const res = await apiRequest('/rewards');
            const unclaimed = (res.rewards || []).filter(r => !r.claimed).length;
            const badge = document.getElementById('navRewardsCountBadge');
            if (badge) {
                badge.textContent = `${unclaimed} Reward${unclaimed === 1 ? '' : 's'}`;
            }
        } catch (e) {}
    }

    function initRewardsAndScratchCard() {
        const navRewardsBtn = document.getElementById('navRewardsBtn');
        const rewardsModal = document.getElementById('rewardsModal');
        const scratchModal = document.getElementById('scratchModal');
        const claimScratchBtn = document.getElementById('btnClaimScratchReward');

        navRewardsBtn?.addEventListener('click', () => {
            loadAndRenderRewards();
            rewardsModal?.showModal();
        });

        claimScratchBtn?.addEventListener('click', () => {
            scratchModal?.close();
            rewardsModal?.showModal();
            loadAndRenderRewards();
        });
    }

    async function loadAndRenderRewards() {
        const grid = document.getElementById('rewardsGrid');
        if (!grid) return;

        grid.innerHTML = '<div style="padding: 20px; text-align: center; color: var(--text-muted); font-size: 12px;">Loading rewards...</div>';

        try {
            const res = await apiRequest('/rewards');
            const rewards = res.rewards || [];

            if (!rewards.length) {
                grid.innerHTML = '<div style="padding: 24px; text-align: center; color: var(--text-muted); font-size: 13px;">No rewards yet. Pay bills or transfer > ₹100 to earn mystery scratch cards!</div>';
                return;
            }

            grid.innerHTML = rewards.map(r => {
                if (r.claimed) {
                    return `
                        <div class="reward-card-tile reward-tile-claimed">
                            <span class="reward-shimmer-badge">🎉</span>
                            <h4>${escapeHtml(r.title)}</h4>
                            <div class="reward-claimed-amt">+${formatINR(r.amount)}</div>
                            <p>Credited to Wallet</p>
                        </div>
                    `;
                } else {
                    return `
                        <div class="reward-card-tile unclaimed" onclick="window.NovaApp.openScratchCard(${r.id}, ${r.amount}, '${escapeHtml(r.title)}')">
                            <span class="reward-shimmer-badge">🎁</span>
                            <h4>${escapeHtml(r.title)}</h4>
                            <p>Tap to Scratch</p>
                        </div>
                    `;
                }
            }).join('');

            updateRewardsBadge();
        } catch (err) {
            grid.innerHTML = `<div style="padding: 20px; color: var(--danger); font-size: 12px;">Failed to load rewards: ${escapeHtml(err.message)}</div>`;
        }
    }

    function openScratchCard(rewardId, amount, title) {
        document.getElementById('rewardsModal')?.close();
        const scratchModal = document.getElementById('scratchModal');
        if (!scratchModal) return;

        activeScratchingReward = { id: rewardId, amount, title, claimed: false };

        const amtEl = document.getElementById('scratchRewardAmount');
        const descEl = document.getElementById('scratchRewardDesc');
        const claimBtn = document.getElementById('btnClaimScratchReward');

        if (amtEl) amtEl.textContent = formatINR(amount);
        if (descEl) descEl.textContent = title;
        if (claimBtn) claimBtn.style.display = 'none';

        scratchModal.showModal();
        setupScratchCanvas();
    }

    function setupScratchCanvas() {
        const canvas = document.getElementById('scratchCanvas');
        if (!canvas) return;

        canvas.width = 260;
        canvas.height = 260;
        const ctx = canvas.getContext('2d');
        if (!ctx) return;

        // Draw opaque metallic foil cover with CRED pattern
        ctx.fillStyle = '#64748b';
        ctx.fillRect(0, 0, 260, 260);

        // Holographic diagonal streaks
        const grad = ctx.createLinearGradient(0, 0, 260, 260);
        grad.addColorStop(0, '#94a3b8');
        grad.addColorStop(0.3, '#cbd5e1');
        grad.addColorStop(0.5, '#64748b');
        grad.addColorStop(0.7, '#cbd5e1');
        grad.addColorStop(1, '#94a3b8');
        ctx.fillStyle = grad;
        ctx.fillRect(0, 0, 260, 260);

        // Foil branding
        ctx.fillStyle = '#1e293b';
        ctx.font = 'bold 16px Inter, sans-serif';
        ctx.textAlign = 'center';
        ctx.fillText('NOVA REWARDS', 130, 115);

        ctx.fillStyle = '#475569';
        ctx.font = '600 11px Inter, sans-serif';
        ctx.fillText('Rub to reveal cashback', 130, 145);

        ctx.fillStyle = '#f59e0b';
        ctx.font = '22px Inter, sans-serif';
        ctx.fillText('✨', 130, 80);

        let isScratching = false;

        function scratch(x, y) {
            ctx.globalCompositeOperation = 'destination-out';
            ctx.beginPath();
            ctx.arc(x, y, 22, 0, Math.PI * 2);
            ctx.fill();
            checkScratchProgress();
        }

        function getPos(e) {
            const rect = canvas.getBoundingClientRect();
            const clientX = e.touches ? e.touches[0].clientX : e.clientX;
            const clientY = e.touches ? e.touches[0].clientY : e.clientY;
            return {
                x: clientX - rect.left,
                y: clientY - rect.top
            };
        }

        canvas.onmousedown = (e) => { isScratching = true; const p = getPos(e); scratch(p.x, p.y); };
        window.onmouseup = () => { isScratching = false; };
        canvas.onmousemove = (e) => { if (isScratching) { const p = getPos(e); scratch(p.x, p.y); } };

        canvas.ontouchstart = (e) => { isScratching = true; const p = getPos(e); scratch(p.x, p.y); };
        window.ontouchend = () => { isScratching = false; };
        canvas.ontouchmove = (e) => {
            if (isScratching) {
                e.preventDefault();
                const p = getPos(e);
                scratch(p.x, p.y);
            }
        };

        let checkedTimeout = null;
        function checkScratchProgress() {
            if (activeScratchingReward?.claimed) return;
            if (checkedTimeout) return;

            checkedTimeout = setTimeout(() => {
                checkedTimeout = null;
                const imgData = ctx.getImageData(0, 0, canvas.width, canvas.height);
                const pixels = imgData.data;
                let transparent = 0;
                const total = pixels.length / 4;

                // Sample every 4th pixel for speed
                for (let i = 3; i < pixels.length; i += 16) {
                    if (pixels[i] === 0) transparent++;
                }

                const ratio = transparent / (total / 4);
                if (ratio > 0.40 && !activeScratchingReward.claimed) {
                    activeScratchingReward.claimed = true;
                    // Auto reveal rest with clear
                    ctx.clearRect(0, 0, canvas.width, canvas.height);
                    triggerRewardClaim(activeScratchingReward.id);
                }
            }, 80);
        }
    }

    async function triggerRewardClaim(rewardId) {
        try {
            playSuccessChime();
            launchConfetti();

            const res = await apiRequest('/rewards/claim', {
                method: 'POST',
                body: JSON.stringify({ reward_id: rewardId })
            });

            showToast(res.msg || 'Cashback credited to wallet!');
            document.getElementById('btnClaimScratchReward').style.display = 'inline-flex';
            fetchUserData();
            updateRewardsBadge();
        } catch (err) {
            showToast(err.message, true);
        }
    }

    // -------------------------------------------------------------------------
    // Jupiter / RazorpayX Titanium Card Controls
    // -------------------------------------------------------------------------
    function initCardControls() {
        const freezeBtn = document.getElementById('btnToggleFreeze');
        const revealBtn = document.getElementById('btnRevealCardDetails');
        const switchBankBtn = document.getElementById('btnSwitchBankInstrument');
        const limitSlider = document.getElementById('sliderDailyLimit');
        const limitDisplay = document.getElementById('dailyLimitDisplay');
        const freezeOverlay = document.getElementById('cardFrozenOverlay');
        const copyPanBtn = document.getElementById('copyCardNumberBtn');

        // Toggle Card Freeze
        freezeBtn?.addEventListener('click', async () => {
            toggleBtnLoading('btnToggleFreeze', true);
            try {
                const res = await apiRequest('/card/freeze', { method: 'POST' });
                showToast(res.msg);
                if (freezeOverlay) {
                    freezeOverlay.style.display = res.frozen ? 'flex' : 'none';
                }
                if (freezeBtn) {
                    freezeBtn.classList.toggle('active-freeze', res.frozen);
                    freezeBtn.innerHTML = res.frozen
                        ? `<span>❄️</span><span>Unfreeze Card</span>`
                        : `<span>🔒</span><span>Freeze Card</span>`;
                }
            } catch (err) {
                showToast(err.message, true);
            } finally {
                toggleBtnLoading('btnToggleFreeze', false, freezeOverlay?.style.display === 'flex' ? 'Unfreeze Card' : 'Freeze Card');
            }
        });

        // Reveal 16-Digit PAN and CVV
        revealBtn?.addEventListener('click', async () => {
            toggleBtnLoading('btnRevealCardDetails', true);
            try {
                const res = await apiRequest('/card/reveal', { method: 'POST' });
                const panEl = document.getElementById('revealedPan');
                const holderEl = document.getElementById('revealedHolder');
                const expEl = document.getElementById('revealedExpiry');
                const cvvEl = document.getElementById('revealedCvv');

                if (panEl) panEl.textContent = res.card_number;
                if (holderEl) holderEl.textContent = res.cardholder;
                if (expEl) expEl.textContent = res.expiry;
                if (cvvEl) cvvEl.textContent = res.cvv;

                document.getElementById('cardRevealModal')?.showModal();
            } catch (err) {
                showToast(err.message, true);
            } finally {
                toggleBtnLoading('btnRevealCardDetails', false, 'Reveal Details');
            }
        });

        // Copy 16-digit card number
        copyPanBtn?.addEventListener('click', () => {
            const pan = document.getElementById('revealedPan')?.textContent?.replace(/\s/g, '');
            if (pan) {
                navigator.clipboard.writeText(pan).then(() => {
                    showToast('16-Digit Card Number copied!');
                }).catch(() => {
                    showToast('Failed to copy card number', true);
                });
            }
        });

        // Switch linked bank instrument
        switchBankBtn?.addEventListener('click', async () => {
            toggleBtnLoading('btnSwitchBankInstrument', true);
            try {
                const res = await apiRequest('/card/switch_bank', { method: 'POST' });
                showToast(res.msg);
                fetchUserData();
            } catch (err) {
                showToast(err.message, true);
            } finally {
                toggleBtnLoading('btnSwitchBankInstrument', false, 'Switch Bank');
            }
        });

        // Daily Limit Slider
        let limitDebounceTimer = null;
        limitSlider?.addEventListener('input', (e) => {
            const val = Number(e.target.value) || 0;
            if (limitDisplay) limitDisplay.textContent = formatINR(val);

            clearTimeout(limitDebounceTimer);
            limitDebounceTimer = setTimeout(async () => {
                try {
                    await apiRequest('/card/limit', {
                        method: 'POST',
                        body: JSON.stringify({ limit_inr: val })
                    });
                    showToast(`Daily transaction limit set to ${formatINR(val)}`);
                } catch (err) {
                    showToast(err.message, true);
                }
            }, 600);
        });
    }

    // -------------------------------------------------------------------------
    // Notification Bell & Alerts Dropdown
    // -------------------------------------------------------------------------
    function initNotifications() {
        const bellBtn = document.getElementById('notifBellBtn');
        const dropdown = document.getElementById('notifDropdown');
        const clearBtn = document.getElementById('markNotifsReadBtn');

        bellBtn?.addEventListener('click', (e) => {
            e.stopPropagation();
            if (!dropdown) return;
            const isVisible = dropdown.style.display === 'block';
            dropdown.style.display = isVisible ? 'none' : 'block';
            if (!isVisible) {
                loadNotifications();
            }
        });

        document.addEventListener('click', (e) => {
            if (dropdown && !dropdown.contains(e.target) && e.target !== bellBtn) {
                dropdown.style.display = 'none';
            }
        });

        clearBtn?.addEventListener('click', async () => {
            try {
                await apiRequest('/notifications/read', { method: 'POST' });
                const dot = document.getElementById('notifDot');
                if (dot) dot.style.display = 'none';
                loadNotifications();
                showToast('All notifications marked as read');
            } catch (e) {}
        });
    }

    async function loadNotifications() {
        const list = document.getElementById('notifList');
        const dot = document.getElementById('notifDot');
        if (!list) return;

        try {
            const res = await apiRequest('/notifications');
            const notifs = res.notifications || [];

            if (dot) {
                dot.style.display = res.unread_count > 0 ? 'block' : 'none';
            }

            if (!notifs.length) {
                list.innerHTML = '<div class="notif-empty">No new notifications</div>';
                return;
            }

            const icons = {
                security: '🛡️',
                transaction: '💳',
                reward: '🎁',
                info: 'ℹ️'
            };

            list.innerHTML = notifs.map(n => `
                <div class="notif-item ${n.read ? '' : 'unread'}">
                    <div class="notif-icon-circle">${icons[n.category] || '🔔'}</div>
                    <div class="notif-content">
                        <div class="notif-title">${escapeHtml(n.title)}</div>
                        <div class="notif-desc">${escapeHtml(n.message)}</div>
                        <div class="notif-time">${escapeHtml(n.timestamp || 'Just now')}</div>
                    </div>
                </div>
            `).join('');
        } catch (e) {
            list.innerHTML = '<div class="notif-empty">Failed to load alerts</div>';
        }
    }

    // -------------------------------------------------------------------------
    // Google Pay / WhatsApp Shareable Receipt Modal
    // -------------------------------------------------------------------------
    let currentReceiptData = null;

    function openShareReceipt(data) {
        currentReceiptData = data;
        const modal = document.getElementById('shareReceiptModal');
        if (!modal) return;

        const amtEl = document.getElementById('shareReceiptAmt');
        const recvEl = document.getElementById('shareReceiptReceiver');
        const refEl = document.getElementById('shareReceiptRef');
        const timeEl = document.getElementById('shareReceiptTime');
        const bankEl = document.getElementById('shareReceiptBank');

        if (amtEl) amtEl.textContent = typeof data.amount === 'number' ? formatINR(data.amount) : data.amount;
        if (recvEl) recvEl.textContent = data.receiver || 'Merchant';
        if (refEl) refEl.textContent = data.txn_id || 'TXN_SUCCESS';
        if (timeEl) timeEl.textContent = data.timestamp || new Date().toLocaleString('en-IN');
        if (bankEl) bankEl.textContent = data.bank || 'HDFC Bank •••• 4821';

        modal.showModal();
    }

    function initShareReceiptModal() {
        const shareWaBtn = document.getElementById('btnShareWhatsApp');
        const downloadBtn = document.getElementById('btnDownloadReceiptPng');

        shareWaBtn?.addEventListener('click', () => {
            if (!currentReceiptData) return;
            const amt = typeof currentReceiptData.amount === 'number' ? formatINR(currentReceiptData.amount) : currentReceiptData.amount;
            const text = encodeURIComponent(
                `*NovaWallet UPI 2.0 Payment Receipt*\n\n` +
                `✅ *Status:* Payment Successful\n` +
                `💵 *Amount:* ${amt}\n` +
                `👤 *Paid to:* ${currentReceiptData.receiver}\n` +
                `🏦 *Debited From:* ${currentReceiptData.bank || 'HDFC Bank'}\n` +
                `🔢 *UPI Ref ID:* ${currentReceiptData.txn_id}\n` +
                `📅 *Timestamp:* ${currentReceiptData.timestamp || new Date().toLocaleString('en-IN')}\n\n` +
                `_Powered by NovaWallet Instant Settlement Network_`
            );
            window.open(`https://api.whatsapp.com/send?text=${text}`, '_blank');
        });

        downloadBtn?.addEventListener('click', () => {
            if (!currentReceiptData) return;
            const amt = typeof currentReceiptData.amount === 'number' ? formatINR(currentReceiptData.amount) : currentReceiptData.amount;
            const receiptText =
                `========================================\n` +
                `       NOVAWALLET PAYMENT RECEIPT        \n` +
                `========================================\n` +
                `Status: Payment Successful\n` +
                `Amount: ${amt}\n` +
                `Paid to: ${currentReceiptData.receiver}\n` +
                `Debited From: ${currentReceiptData.bank || 'HDFC Bank'}\n` +
                `UPI Ref ID: ${currentReceiptData.txn_id}\n` +
                `Date: ${currentReceiptData.timestamp || new Date().toLocaleString('en-IN')}\n` +
                `========================================\n` +
                `Verified by NPCI UPI 2.0 Engine\n`;

            const blob = new Blob([receiptText], { type: 'text/plain' });
            const url = URL.createObjectURL(blob);
            const a = document.createElement('a');
            a.href = url;
            a.download = `NovaReceipt_${currentReceiptData.txn_id || 'payment'}.txt`;
            document.body.appendChild(a);
            a.click();
            document.body.removeChild(a);
            URL.revokeObjectURL(url);
            showToast('Receipt saved to device');
        });
    }

    // -------------------------------------------------------------------------
    // Real-Time Background Sync Engine
    // -------------------------------------------------------------------------
    function initBackgroundSync() {
        setInterval(async () => {
            if (!state.token || !state.activeUser) return;
            try {
                const res = await apiRequest('/sync');
                if (res.wallet) {
                    if (res.wallet.wallet_balance !== state.currentWalletBalance) {
                        fetchUserData();
                    }
                    const dot = document.getElementById('notifDot');
                    if (dot) {
                        dot.style.display = res.unread_notifications > 0 ? 'block' : 'none';
                    }
                    const badge = document.getElementById('navRewardsCountBadge');
                    if (badge && res.unclaimed_rewards !== undefined) {
                        badge.textContent = `${res.unclaimed_rewards} Reward${res.unclaimed_rewards === 1 ? '' : 's'}`;
                    }
                }
            } catch (e) {}
        }, 15000);
    }

    // -------------------------------------------------------------------------
    // Global Lifecycle Entrypoint
    // -------------------------------------------------------------------------
    document.addEventListener('DOMContentLoaded', () => {
        initTheme();
        initAuth();
        initUpiAndBankControls();
        initQuickAmountPills();
        initSmsBannerAndOtpBoxes();
        initFiltersAndSearch();
        initReceiptModal();
        initExport();
        initVaults();
        initNovaAi();
        initPanels();
        initSplitBill();
        initDialogLightDismissFallbacks();
        initMpinModal();
        initBbpsBills();
        initCardControls();
        initRewardsAndScratchCard();
        initNotifications();
        initShareReceiptModal();
        initBackgroundSync();

        if (state.token && state.activeUser) {
            document.getElementById('auth').style.display = 'none';
            document.getElementById('dashboard').style.display = 'block';
            document.getElementById('userBadge').textContent = '@' + state.activeUser.toLowerCase();
            updateUpiVpa(state.activeUser);
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
        cancelRequest,
        selectPeer,
        openReceipt,
        openScratchCard,
        openShareReceipt,
        openMpinSheet
    };

})();
