import { useEffect, useState } from 'react';

const MIGRATED_KEY = 'feedback_sheet_migration_complete';
const THEME_KEY = 'feedback_theme_preference';

async function apiRequest(path, { method = 'GET', body, timeoutMs = 15000 } = {}) {
  const controller = new AbortController();
  const timeout = window.setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(`/api/${path}`, {
      method,
      credentials: 'same-origin',
      headers: {
        ...(body ? { 'Content-Type': 'application/json' } : {}),
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
      signal: controller.signal,
    });
    if (response.status === 204) return null;
    const responseText = await response.text();
    let result;
    try {
      result = responseText ? JSON.parse(responseText) : {};
    } catch {
      const detail = responseText.trim().replace(/\s+/g, ' ').slice(0, 180);
      const error = new Error(
        `The API returned an invalid response (HTTP ${response.status})${detail ? `: ${detail}` : '.'}`,
      );
      error.status = response.status;
      throw error;
    }
    if (!response.ok) {
      const error = new Error(result.error || 'The request could not be completed.');
      error.status = response.status;
      throw error;
    }
    return result;
  } catch (error) {
    if (error.name === 'AbortError') {
      throw new Error('The API did not respond in time. Check the Vercel function logs and environment variables.');
    }
    throw error;
  } finally {
    window.clearTimeout(timeout);
  }
}

function legacyData(key) {
  try {
    const data = JSON.parse(localStorage.getItem(key) || '[]');
    return Array.isArray(data) ? data : [];
  } catch {
    return [];
  }
}

async function migrateLegacyData() {
  if (localStorage.getItem(MIGRATED_KEY)) {
    localStorage.removeItem('feedback_users');
    localStorage.removeItem('feedback_data');
    return;
  }
  const users = legacyData('feedback_users');
  const feedback = legacyData('feedback_data');
  if (users.length || feedback.length) {
    await apiRequest('migrate/local-storage', {
      method: 'POST',
      body: { users, feedback },
    });
    localStorage.removeItem('feedback_users');
    localStorage.removeItem('feedback_data');
  }
  localStorage.setItem(MIGRATED_KEY, 'true');
}

function Stars({ rating }) {
  return <span className="stars" aria-label={`${rating} out of 5 stars`}>{'★'.repeat(rating)}{'☆'.repeat(5 - rating)}</span>;
}

export default function App() {
  const [feedback, setFeedback] = useState([]);
  const [chatMessages, setChatMessages] = useState([{ role: 'assistant', content: 'Hi! Tell me what happened, or ask me how FeedbackHub works. I can connect you with a person if you need more help.' }]);
  const [chatFlow, setChatFlow] = useState({ stage: 'idle', issue: '' });
  const [chatLoading, setChatLoading] = useState(false);
  const [supportTickets, setSupportTickets] = useState([]);
  const [currentUser, setCurrentUser] = useState(null);
  const [view, setView] = useState('home');
  const [apiError, setApiError] = useState('');
  const [ready, setReady] = useState(false);
  const [theme, setTheme] = useState(() => localStorage.getItem(THEME_KEY)
    || (window.matchMedia?.('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'));

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    localStorage.setItem(THEME_KEY, theme);
  }, [theme]);

  useEffect(() => {
    const elements = [...document.querySelectorAll('.scroll-reveal:not(.revealed)')];
    if (!('IntersectionObserver' in window)) {
      elements.forEach((element) => element.classList.add('revealed'));
      return undefined;
    }
    const observer = new IntersectionObserver((entries) => {
      entries.forEach((entry) => {
        if (entry.isIntersecting) {
          entry.target.classList.add('revealed');
          observer.unobserve(entry.target);
        }
      });
    }, { threshold: 0.12, rootMargin: '0px 0px -28px 0px' });
    elements.forEach((element) => observer.observe(element));
    return () => observer.disconnect();
  }, [view, ready, feedback.length]);

  function toggleTheme() {
    setTheme((current) => current === 'dark' ? 'light' : 'dark');
  }

  useEffect(() => {
    let active = true;
    setReady(true);
    async function initialize() {
      localStorage.removeItem('feedback_session_token');
      let user = null;
      try {
        const session = await apiRequest('session');
        user = session.user;
      } catch (error) {
        if (error.status === 401) {
          try { await apiRequest('auth/logout', { method: 'POST' }); } catch { /* session is already unusable */ }
        } else if (active) setApiError(error.message);
      }

      if (user?.role === 'admin') {
        try { await migrateLegacyData(); }
        catch (error) { if (active) setApiError(error.message); }
      }
      if (user) {
        try { const support = await apiRequest('support'); if (active) setSupportTickets(support.tickets); }
        catch (error) { if (active) setApiError(error.message); }
      }
      try {
        const result = await apiRequest('feedback');
        if (active) {
          setFeedback(result.feedback);
          if (user) {
            setCurrentUser(user);
            setView(user.role === 'admin' ? 'admin' : 'user');
          }
        }
      } catch (error) {
        if (active) setApiError(error.message);
      }
      if (active) setReady(true);
    }
    initialize();
    return () => { active = false; };
  }, []);

  const publicFeedback = [...feedback].sort((a, b) => b.rating - a.rating);

  function logout() {
    setCurrentUser(null);
    setApiError('');
    apiRequest('auth/logout', { method: 'POST' })
      .then(() => apiRequest('feedback'))
      .then((result) => setFeedback(result.feedback))
      .catch((error) => setApiError(error.message));
    setView('home');
  }

  async function enterDashboard(result) {
    setCurrentUser(result.user);
    setView(result.user.role === 'admin' ? 'admin' : 'user');
    setApiError('');
    try {
      if (result.user.role === 'admin') await migrateLegacyData();
      const data = await apiRequest('feedback');
      setFeedback(data.feedback);
      if (result.user.role === 'admin') {
        const support = await apiRequest('support');
        setSupportTickets(support.tickets);
      }
    } catch (error) {
      setApiError(error.message);
    }
  }

  async function authenticate(email, password, captchaId, captchaAnswer) {
    try {
      const result = await apiRequest('auth/login', { method: 'POST', body: { email, password, captchaId, captchaAnswer } });
      await enterDashboard(result);
      return { ok: true };
    } catch (error) {
      return { ok: false, error: error.message };
    }
  }

  async function register(name, email, password, captchaId, captchaAnswer) {
    try {
      const result = await apiRequest('auth/signup', { method: 'POST', body: { name, email, password, captchaId, captchaAnswer } });
      await enterDashboard(result);
      return '';
    } catch (error) {
      return error.message;
    }
  }

  async function submitFeedback(item) {
    const pendingId = `pending-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const pendingFeedback = {
      ...item,
      id: pendingId,
      userId: currentUser.id,
      userName: currentUser.name,
      status: 'Submitted',
      createdAt: new Date().toISOString(),
      pending: true,
    };
    setFeedback((items) => [pendingFeedback, ...items]);
    try {
      const result = await apiRequest('feedback', { method: 'POST', body: item, timeoutMs: 30000 });
      setFeedback((items) => items.map((entry) => entry.id === pendingId ? result.feedback : entry));
    } catch (error) {
      setFeedback((items) => items.filter((entry) => entry.id !== pendingId));
      throw error;
    }
  }

  async function updateFeedbackStatus(id, status) {
    const result = await apiRequest(`feedback/${encodeURIComponent(id)}`, { method: 'PATCH', body: { status } });
    setFeedback((items) => items.map((item) => item.id === id ? result.feedback : item));
  }

  async function deleteFeedback(id) {
    await apiRequest(`feedback/${encodeURIComponent(id)}`, { method: 'DELETE' });
    setFeedback((items) => items.filter((item) => item.id !== id));
  }

  async function sendChat(messages) {
    setChatMessages(messages);
    setChatLoading(true);
    try {
      const result = await apiRequest('assistant/chat', { method: 'POST', body: { messages }, timeoutMs: 30000 });
      setChatMessages((current) => [...messages, { role: 'assistant', content: result.reply }]);
    } catch (error) {
      setChatMessages((current) => [...messages, { role: 'assistant', content: error.message }]);
    } finally { setChatLoading(false); }
  }

  async function handoffChat(messages, issue) {
    const result = await apiRequest('support/handoff', { method: 'POST', body: { messages, issue } });
    setSupportTickets((current) => [result.ticket, ...current]);
    return result.ticket;
  }

  async function sendSupportMessage(ticketId, content) {
    const result = await apiRequest(`support/${encodeURIComponent(ticketId)}/messages`, { method: 'POST', body: { content } });
    setSupportTickets((current) => current.map((ticket) => ticket.id === ticketId ? result.ticket : ticket));
    return result.ticket;
  }

  async function refreshSupport() {
    const result = await apiRequest('support');
    setSupportTickets(result.tickets);
    return result.tickets;
  }

  function startNewSupportRequest() {
    setChatMessages([{ role: 'assistant', content: 'Hi! Tell me what happened, or ask me how FeedbackHub works. I can connect you with a person if you need more help.' }]);
    setChatFlow({ stage: 'idle', issue: '' });
  }

  useEffect(() => {
    if (!currentUser || !['admin', 'user'].includes(currentUser.role) || !['admin', 'user'].includes(view)) return undefined;
    let active = true;
    let inFlight = false;
    async function refreshVisibleSupport() {
      if (!active || document.visibilityState !== 'visible' || inFlight) return;
      inFlight = true;
      try {
        const result = await apiRequest('support');
        if (active) setSupportTickets(result.tickets);
      } catch {
        // Keep the current conversation visible if the sheet is briefly unavailable.
      } finally {
        inFlight = false;
      }
    }
    const timer = window.setInterval(refreshVisibleSupport, 5000);
    document.addEventListener('visibilitychange', refreshVisibleSupport);
    return () => {
      active = false;
      window.clearInterval(timer);
      document.removeEventListener('visibilitychange', refreshVisibleSupport);
    };
  }, [currentUser?.id, currentUser?.role, view]);

  async function updateSupport(ticketId, status, adminReply) {
    const result = await apiRequest(`support/${encodeURIComponent(ticketId)}`, { method: 'PATCH', body: { status, adminReply } });
    setSupportTickets((current) => current.map((ticket) => ticket.id === ticketId ? result.ticket : ticket));
  }

  if (view === 'signup' || view === 'login') {
    return <AuthPage mode={view} theme={theme} onToggleTheme={toggleTheme} onAuthenticate={authenticate} onRegister={register} onNavigate={setView} />;
  }

  if (currentUser?.role === 'admin' && view === 'admin') {
    return <AdminDashboard user={currentUser} feedback={feedback} supportTickets={supportTickets} onUpdateSupport={updateSupport} onSendSupportMessage={sendSupportMessage} onRefreshSupport={refreshSupport} onStatusChange={updateFeedbackStatus} onDelete={deleteFeedback} onLogout={logout} apiError={apiError} theme={theme} onToggleTheme={toggleTheme} />;
  }

  if (currentUser?.role === 'user' && view === 'user') {
    return <><UserDashboard user={currentUser} feedback={feedback} onSubmitFeedback={submitFeedback} supportTickets={supportTickets} onRefreshSupport={refreshSupport} onLogout={logout} apiError={apiError} theme={theme} onToggleTheme={toggleTheme} /><ChatWidget user={currentUser} messages={chatMessages} flow={chatFlow} onFlowChange={setChatFlow} onNewRequest={startNewSupportRequest} loading={chatLoading} onSend={sendChat} onSetMessages={setChatMessages} onHandoff={handoffChat} onSendSupportMessage={sendSupportMessage} supportTickets={supportTickets} onRefreshSupport={refreshSupport} /></>;
  }

  if (!ready) return <div className="loading-screen">Connecting to FeedbackHub...</div>;

  return (
    <>
    <div className="site-shell">
      <header className="topbar">
        <button className="brand" onClick={() => setView('home')}><span className="brand-mark">F</span> FeedbackHub</button>
        <nav>
          <ThemeToggle theme={theme} onToggle={toggleTheme} />
          <button className="nav-link" onClick={() => document.getElementById('reviews')?.scrollIntoView({ behavior: 'smooth' })}>Reviews</button>
          <button className="button button-ghost action-login" onClick={() => document.getElementById('login-panel')?.scrollIntoView({ behavior: 'smooth' })}><Icon name="login" />Login</button>
          <button className="button action-create" onClick={() => setView('signup')}><Icon name="user-plus" />Get started</button>
        </nav>
      </header>

      <main>
        {apiError && <div className="api-notice" role="alert">{apiError}</div>}
        <section className="hero">
          <div className="scroll-reveal">
            <span className="eyebrow">CUSTOMER VOICE PLATFORM</span>
            <h1>Turn honest feedback into better experiences.</h1>
            <p>Share your experience, track support conversations, and help organizations improve what matters most.</p>
            <div className="hero-actions">
              <button className="button button-large button-share" onClick={() => setView('signup')}>
                <span>Share feedback</span>
                <span className="plane-flight" aria-hidden="true">
                  <svg className="flight-trail" viewBox="0 0 36 28"><defs><linearGradient id="flight-metal" x1="0" y1="1" x2="1" y2="0"><stop stopColor="#8de1d1"/><stop offset="1" stopColor="#ffe3a0"/></linearGradient></defs><path d="M2 24C11 22 8 13 17 12S27 10 34 3"/></svg>
                  <svg className="paper-plane" viewBox="0 0 24 24">
                    <defs><linearGradient id="plane-metal" x1="0" y1="1" x2="1" y2="0"><stop stopColor="#f5ca73"/><stop offset=".55" stopColor="#fff4d1"/><stop offset="1" stopColor="#ffffff"/></linearGradient></defs>
                    <path className="plane-shell" d="M22 2 14.3 22l-3.7-8-8-3.7L22 2Z"/>
                    <path className="plane-fold" d="M10.6 14 22 2"/>
                    <path className="plane-glint" d="m14.3 18.2-2.1-4.2"/>
                  </svg>
                  <span className="flight-spark">✦</span>
                </span>
              </button>
              <button className="text-button action-login" onClick={() => document.getElementById('login-panel')?.scrollIntoView({ behavior: 'smooth' })}>Sign in <Icon name="arrow-right" /></button>
            </div>
          </div>
          <div className="hero-panel glass-hover scroll-reveal" id="login-panel" aria-label="Login form">
            <div className="panel-heading"><span>Login details</span><span className="live-dot">● Active</span></div>
            <PulseLogin authenticate={authenticate} onNavigate={setView} />
          </div>
        </section>

        <section className="reviews-section" id="reviews">
          <div className="section-heading scroll-reveal">
            <div><span className="eyebrow">COMMUNITY VOICES</span><h2>Feedback that makes a difference</h2></div>
            <p>Community feedback and its latest status.</p>
          </div>
          <div className="review-grid">
            {publicFeedback.map((item, index) => (
              <article className="review-card glass-hover scroll-reveal" key={item.id} style={{ '--reveal-delay': `${Math.min(index * 75, 300)}ms` }}>
                <Stars rating={item.rating} />
                <p>“{item.message}”</p>
                <div className="review-card-footer">
                  <div><strong>{item.userName}</strong><span>{item.category}</span></div>
                  <span className={`status status-${item.status.toLowerCase().replace(' ', '-')}`}>{item.status}</span>
                </div>
              </article>
            ))}
          </div>
        </section>
      </main>
      <footer><span>FeedbackHub</span><small>© 2026 Feedback Management System</small></footer>
    </div>
    <ChatWidget user={currentUser} messages={chatMessages} flow={chatFlow} onFlowChange={setChatFlow} onNewRequest={startNewSupportRequest} loading={chatLoading} onSend={sendChat} onSetMessages={setChatMessages} onHandoff={handoffChat} onSendSupportMessage={sendSupportMessage} supportTickets={supportTickets} onRefreshSupport={refreshSupport} onNavigate={setView} />
    </>
  );
}

function PulseLogin({ authenticate, onNavigate }) {
  const [error, setError] = useState('');
  const [captcha, setCaptcha] = useState(null);
  const [captchaAnswer, setCaptchaAnswer] = useState('');

  async function refreshCaptcha() {
    setCaptchaAnswer('');
    try { setCaptcha(await apiRequest('captcha')); }
    catch { setCaptcha(null); setError('Could not load CAPTCHA. Please refresh the page.'); }
  }

  useEffect(() => { refreshCaptcha(); }, []);

  async function submit(event) {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    const result = await authenticate(data.get('email').trim(), data.get('password'), captcha?.id, captchaAnswer);
    setError(result.ok ? '' : result.error);
    if (!result.ok) refreshCaptcha();
  }

  return (
    <form className="pulse-login" onSubmit={submit}>
      <label>Email address<input name="email" type="email" required placeholder="Enter email" /></label>
      <label>Password<input name="password" type="password" required autoComplete="current-password" placeholder="Enter password" /></label>
      <label className="captcha-label">Security check</label>
      <div className="pulse-captcha">
        {captcha ? <img src={`data:image/svg+xml,${encodeURIComponent(captcha.image)}`} alt="Enter the characters shown in the CAPTCHA image" /> : <span>Loading image…</span>}
        <button type="button" onClick={refreshCaptcha} aria-label="Refresh CAPTCHA">↻</button>
        <input
          type="text"
          required
          autoComplete="off"
          maxLength="5"
          value={captchaAnswer}
          onChange={(event) => setCaptchaAnswer(event.target.value)}
          placeholder="Answer"
          aria-label="CAPTCHA answer"
        />
      </div>
      {error && <div className="pulse-login-error" role="alert">{error}</div>}
      <button className="button action-login" type="submit"><Icon name="login" />Login</button>
      <button className="pulse-signup action-create" type="button" onClick={() => onNavigate('signup')}><Icon name="user-plus" />Create an account</button>
    </form>
  );
}

function Icon({ name, className = 'button-icon' }) {
  const paths = {
    login: <><path className="icon-accent" d="M10 17l5-5-5-5M15 12H3"/><path className="icon-primary" d="M12 3h6a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2h-6"/></>,
    'user-plus': <><circle className="icon-primary" cx="9" cy="8" r="4"/><path className="icon-primary" d="M3 21v-2a6 6 0 0 1 6-6h1"/><path className="icon-accent" d="M19 8v8M15 12h8"/></>,
    'arrow-right': <><path className="icon-primary" d="M4 12h15"/><path className="icon-accent" d="m13 6 6 6-6 6"/></>,
    sun: <><circle className="icon-primary" cx="12" cy="12" r="4"/><path className="icon-accent" d="M12 2v2m0 16v2M4.93 4.93l1.42 1.42m11.3 11.3 1.42 1.42M2 12h2m16 0h2M4.93 19.07l1.42-1.42m11.3-11.3 1.42-1.42"/></>,
    moon: <path className="icon-accent" d="M20.8 13A8.7 8.7 0 0 1 11 3.2 9 9 0 1 0 20.8 13Z"/>,
  };
  return <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{paths[name]}</svg>;
}

function ThemeToggle({ theme, onToggle }) {
  const dark = theme === 'dark';
  return <button className="theme-toggle action-theme" type="button" onClick={onToggle} aria-label={`Switch to ${dark ? 'light' : 'dark'} theme`} title={`Switch to ${dark ? 'light' : 'dark'} theme`}><Icon key={theme} name={dark ? 'sun' : 'moon'} className="button-icon theme-icon"/><span>{dark ? 'Light' : 'Dark'}</span></button>;
}

function AuthPage({ mode, onAuthenticate, onRegister, onNavigate, theme, onToggleTheme }) {
  const [error, setError] = useState('');
  const [captcha, setCaptcha] = useState(null);
  const [captchaAnswer, setCaptchaAnswer] = useState('');
  const isLogin = mode === 'login';

  async function refreshCaptcha() {
    setCaptchaAnswer('');
    try { setCaptcha(await apiRequest('captcha')); }
    catch { setCaptcha(null); setError('Could not load CAPTCHA. Please refresh the page.'); }
  }

  useEffect(() => { refreshCaptcha(); }, []);

  async function submit(event) {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    if (isLogin) {
      const result = await onAuthenticate(data.get('email').trim(), data.get('password'), captcha?.id, captchaAnswer);
      setError(result.ok ? '' : result.error);
      if (!result.ok) refreshCaptcha();
      return;
    }
    if (data.get('password').length < 12) return setError('Password must be at least 12 characters.');
    if (data.get('password') !== data.get('confirmPassword')) return setError('Passwords do not match.');
    const registrationError = await onRegister(data.get('name'), data.get('email'), data.get('password'), captcha?.id, captchaAnswer);
    setError(registrationError);
    if (registrationError) refreshCaptcha();
  }

  return (
    <main className="auth-page">
      <section className="auth-showcase glass-hover scroll-reveal">
        <div className="auth-showcase-top"><button className="brand brand-light" onClick={() => onNavigate('home')}><span className="brand-mark">F</span> FeedbackHub</button><ThemeToggle theme={theme} onToggle={onToggleTheme} /></div>
        <div className="auth-showcase-copy"><span className="eyebrow">FEEDBACK MANAGEMENT</span><h1>{isLogin ? 'Welcome back.' : 'Your voice matters.'}</h1><p>{isLogin ? 'Sign in to manage feedback and follow its progress.' : 'Create an account to submit feedback and track your requests.'}</p></div>
      </section>
      <section className="auth-form-wrap scroll-reveal">
        <form className="auth-form glass-hover" onSubmit={submit}>
          <span className="eyebrow">{isLogin ? 'MEMBER LOGIN' : 'CREATE ACCOUNT'}</span>
          <h2>{isLogin ? 'Sign in' : 'Join FeedbackHub'}</h2>
          {!isLogin && <label>Full name<input name="name" required placeholder="Your name" /></label>}
          <label>Email address<input name="email" type="email" required placeholder="you@example.com" /></label>
          <label>Password<input name="password" type="password" required minLength={isLogin ? undefined : 12} autoComplete={isLogin ? 'current-password' : 'new-password'} placeholder={isLogin ? 'Enter password' : 'Minimum 12 characters'} /></label>
          {!isLogin && <label>Confirm password<input name="confirmPassword" type="password" required autoComplete="new-password" placeholder="Repeat password" /></label>}
          {(
            <div className="captcha-row glass-hover">
              {captcha ? <img className="captcha-question" src={`data:image/svg+xml,${encodeURIComponent(captcha.image)}`} alt="Enter the characters shown in the CAPTCHA image" /> : <div className="captcha-question">Loading image…</div>}
              <button type="button" className="captcha-refresh" onClick={refreshCaptcha} aria-label="Refresh CAPTCHA">↻</button>
              <input
                value={captchaAnswer}
                onChange={(event) => setCaptchaAnswer(event.target.value)}
                type="text"
                autoComplete="off"
                maxLength="5"
                required
                placeholder="Answer"
                aria-label="CAPTCHA answer"
              />
            </div>
          )}
          {error && <div className="form-error" role="alert">{error}</div>}
          <button className={`button button-large ${isLogin ? 'action-login' : 'action-create'}`} type="submit"><Icon name={isLogin ? 'login' : 'user-plus'} />{isLogin ? 'Sign in' : 'Create account'}</button>
          {isLogin ? <p>Sign in with your FeedbackHub account details.</p> : null}
          <div className="auth-switch">{isLogin ? 'New to FeedbackHub?' : 'Already have an account?'} <button className={isLogin ? 'action-create' : 'action-login'} type="button" onClick={() => { setError(''); onNavigate(isLogin ? 'signup' : 'login'); }}><Icon name={isLogin ? 'user-plus' : 'login'} />{isLogin ? 'Create account' : 'Sign in'}</button></div>
          <button type="button" className="back-link" onClick={() => onNavigate('home')}>← Back to home</button>
        </form>
      </section>
    </main>
  );
}

function DashboardShell({ user, title, subtitle, onLogout, children, theme, onToggleTheme }) {
  return (
    <div className="dashboard-shell">
      <aside>
        <div className="sidebar-brand-row"><div className="brand"><span className="brand-mark">F</span> FeedbackHub</div><ThemeToggle theme={theme} onToggle={onToggleTheme} /></div>
        <div className="role-badge">{user.role === 'admin' ? 'ADMIN MODULE' : 'USER MODULE'}</div>
        <nav><span className="active">▦ Overview</span></nav>
        <div className="profile"><div>{user.name.charAt(0).toUpperCase()}</div><span><strong>{user.name}</strong><small>{user.email}</small></span></div>
      </aside>
      <main>
        <header className="dashboard-header"><div><span className="eyebrow">{title}</span><h1>{subtitle}</h1></div><button className="logout-button" onClick={onLogout}>Log out</button></header>
        <div className="dashboard-content">{children}</div>
      </main>
    </div>
  );
}

function AdminDashboard({ user, feedback, supportTickets, onUpdateSupport, onSendSupportMessage, onRefreshSupport, onStatusChange, onDelete, onLogout, apiError, theme, onToggleTheme }) {
  const [filter, setFilter] = useState('All');
  const average = feedback.length ? (feedback.reduce((sum, item) => sum + item.rating, 0) / feedback.length).toFixed(1) : '0.0';
  const visible = filter === 'All' ? feedback : feedback.filter((item) => item.status === filter);

  return (
    <DashboardShell user={user} title="ADMIN MODULE" subtitle="Feedback overview" onLogout={onLogout} theme={theme} onToggleTheme={onToggleTheme}>
      {apiError && <div className="api-notice" role="alert">{apiError}</div>}
      <section className="stats-grid">
        <article className="glass-hover scroll-reveal"><span>Total feedback</span><strong>{feedback.length}</strong><small>All submissions</small></article>
        <article className="glass-hover scroll-reveal"><span>Average rating</span><strong>{average}</strong><small>Out of 5.0</small></article>
        <article className="glass-hover scroll-reveal"><span>Awaiting review</span><strong>{feedback.filter((item) => item.status === 'Submitted').length + feedback.filter((item) => item.status === 'In Review').length}</strong><small>Needs attention</small></article>
      </section>
      <section className="content-card glass-hover scroll-reveal">
        <div className="card-heading">
          <div><h2>All feedback</h2><p>Review, resolve, and manage submissions.</p></div>
          <select value={filter} onChange={(event) => setFilter(event.target.value)} aria-label="Filter feedback">
            <option>All</option><option>Submitted</option><option>In Review</option><option>Resolved</option>
          </select>
        </div>
        <FeedbackTable feedback={visible} onStatusChange={onStatusChange} onDelete={onDelete} admin />
      </section>
      <AdminSupportPanel tickets={supportTickets} onUpdate={onUpdateSupport} onSendMessage={onSendSupportMessage} onRefresh={onRefreshSupport} />
    </DashboardShell>
  );
}

function UserDashboard({ user, feedback, onSubmitFeedback, supportTickets, onRefreshSupport, onLogout, apiError, theme, onToggleTheme }) {
  const [category, setCategory] = useState('Service');
  const [rating, setRating] = useState(5);
  const [text, setText] = useState('');
  const [done, setDone] = useState(false);
  const [submitError, setSubmitError] = useState('');
  const [isSubmitting, setIsSubmitting] = useState(false);
  const myFeedback = feedback.filter((item) => item.userId === user.id).sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));

  async function submit(event) {
    event.preventDefault();
    setIsSubmitting(true);
    setDone(false);
    setSubmitError('');
    try {
      await onSubmitFeedback({
      category,
      rating: Number(rating),
      message: text.trim(),
      });
      setText('');
      setRating(5);
      setDone(true);
    } catch (error) {
      setDone(false);
      setSubmitError(error.message);
    } finally {
      setIsSubmitting(false);
    }
  }

  return (
    <DashboardShell user={user} title="USER MODULE" subtitle={`Good to see you, ${user.name.split(' ')[0]}`} onLogout={onLogout} theme={theme} onToggleTheme={onToggleTheme}>
      {apiError && <div className="api-notice" role="alert">{apiError}</div>}
      <div className="user-layout">
        <section className="content-card feedback-form-card glass-hover scroll-reveal">
          <div className="card-heading"><div><h2>Share feedback</h2><p>Tell us about your recent experience.</p></div></div>
          <form onSubmit={submit}>
            <label>Category<select value={category} onChange={(event) => setCategory(event.target.value)}><option>Service</option><option>Product</option><option>Support</option><option>Website</option><option>Other</option></select></label>
            <label>Rating</label>
            <div className="rating-picker">{[1, 2, 3, 4, 5].map((value) => <button type="button" key={value} className={value <= rating ? 'selected' : ''} onClick={() => setRating(value)}>★</button>)}</div>
            <label>Your feedback<textarea required minLength="10" value={text} onChange={(event) => setText(event.target.value)} placeholder="What went well, or what could be better?" /></label>
            <p className="privacy-note">Your review and display name may appear in the public feedback feed. Please leave out sensitive personal details.</p>
            {done && <div className="success-message">Feedback submitted successfully.</div>}
            {submitError && <div className="form-error" role="alert">{submitError}</div>}
            <button className="button button-large" type="submit" disabled={isSubmitting}>{isSubmitting ? 'Saving…' : 'Submit feedback'}</button>
          </form>
        </section>
        <section className="content-card glass-hover scroll-reveal">
          <div className="card-heading"><div><h2>My submissions</h2><p>Track the status of your feedback.</p></div></div>
          {myFeedback.length ? <div className="mobile-feedback-list">{myFeedback.map((item) => <article key={item.id}><div><Stars rating={item.rating} /><span className={`status ${item.pending ? 'status-pending' : `status-${item.status.toLowerCase().replace(' ', '-')}`}`}>{item.pending ? 'Saving…' : item.status}</span></div><p>{item.message}</p><small>{item.category} · {new Date(item.createdAt).toLocaleDateString()}</small></article>)}</div> : <div className="empty-state"><strong>No feedback yet</strong><p>Your submitted feedback will appear here.</p></div>}
        </section>
      </div>
      <section className="content-card support-status-card glass-hover scroll-reveal">
        <div className="card-heading"><div><h2>Human support</h2><p>Private replies to your support requests appear here.</p></div><button className="button button-ghost" onClick={onRefreshSupport}>Refresh</button></div>
        {supportTickets.length ? <div className="support-ticket-list">{supportTickets.map((ticket) => <article key={ticket.id}>
          <div className="support-ticket-heading"><strong>{ticket.status}</strong><small>{new Date(ticket.createdAt).toLocaleString()}</small></div>
          <div className="support-issue"><strong>Issue</strong><p>{ticket.issue || 'Issue details are in the conversation below.'}</p></div>
          <p>{ticket.adminReply || 'Your request is with the support team. We will reply here.'}</p>
          <details className="user-support-history"><summary>View conversation</summary><div className="support-transcript">{ticket.conversation.map((message, index) => <p key={`${ticket.id}-${index}`}><strong>{message.role === 'user' ? 'You' : message.role === 'human' ? 'Support team' : 'Assistant'}:</strong> {message.content}</p>)}</div></details>
        </article>)}</div> : <div className="empty-state"><strong>No human support requests</strong><p>Use the chat button if you need to speak with a person.</p></div>}
      </section>
    </DashboardShell>
  );
}

function AdminSupportPanel({ tickets, onUpdate, onSendMessage, onRefresh }) {
  const [drafts, setDrafts] = useState({});
  const [statuses, setStatuses] = useState({});
  const [notice, setNotice] = useState('');
  const [busyId, setBusyId] = useState('');
  async function save(ticket) {
    setBusyId(ticket.id); setNotice('');
    try {
      const nextStatus = statuses[ticket.id] || ticket.status;
      if (nextStatus !== ticket.status) await onUpdate(ticket.id, nextStatus);
      const message = (drafts[ticket.id] || '').trim();
      if (message) {
        await onSendMessage(ticket.id, message);
        setDrafts((current) => ({ ...current, [ticket.id]: '' }));
      }
      setNotice(message ? 'Reply sent to the user.' : 'Support status saved.');
    } catch (error) { setNotice(error.message); }
    finally { setBusyId(''); }
  }
  return <section className="content-card support-admin-card glass-hover scroll-reveal">
    <div className="card-heading"><div><h2>Human support</h2><p>Private conversations and replies.</p></div><button className="button button-ghost" onClick={() => onRefresh().catch((error) => setNotice(error.message))}>Refresh</button></div>
    {notice && <div className="support-notice" role="status">{notice}</div>}
    {!tickets.length ? <div className="empty-state"><strong>No open requests</strong><p>Requests for human help will appear here.</p></div> : <div className="support-ticket-list">{tickets.map((ticket) => <article key={ticket.id} className="support-admin-ticket">
      <div className="support-ticket-heading"><strong>{ticket.userName}</strong><span className={`status status-${String(ticket.status).toLowerCase().replace(' ', '-')}`}>{ticket.status}</span></div>
      <a href={`mailto:${encodeURIComponent(ticket.email)}`}>{ticket.email}</a><small>{new Date(ticket.createdAt).toLocaleString()}</small>
      <div className="support-issue"><strong>Issue</strong><p>{ticket.issue || 'Issue details are in the conversation below.'}</p></div>
      <div className="support-transcript">{ticket.conversation.map((message, index) => <p key={`${ticket.id}-${index}`}><strong>{message.role === 'user' ? ticket.userName : message.role === 'human' ? 'Support team' : 'Assistant'}:</strong> {message.content}</p>)}</div>
      <label>Status<select value={statuses[ticket.id] || ticket.status} onChange={(event) => setStatuses((current) => ({ ...current, [ticket.id]: event.target.value }))}><option>Open</option><option>In Review</option><option>Resolved</option></select></label>
      <label>Message the user<textarea value={drafts[ticket.id] || ''} onChange={(event) => setDrafts((current) => ({ ...current, [ticket.id]: event.target.value }))} maxLength="1200" placeholder="Write a reply in this conversation…" /></label>
      <button className="button" disabled={busyId === ticket.id} onClick={() => save(ticket)}>{busyId === ticket.id ? 'Sending…' : 'Save status / send reply'}</button>
    </article>)}</div>}
  </section>;
}

function ChatWidget({ user, messages, flow, onFlowChange, onNewRequest, loading, onSend, onSetMessages, onHandoff, onSendSupportMessage, supportTickets, onRefreshSupport, onNavigate }) {
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState('');
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState('');
  const [tickets, setTickets] = useState(supportTickets || []);
  const [selectedTicketId, setSelectedTicketId] = useState(() => supportTickets?.[0]?.id || '');
  const [viewingNewRequest, setViewingNewRequest] = useState(false);
  useEffect(() => {
    const available = supportTickets || [];
    setTickets(available);
    if (!viewingNewRequest && (!selectedTicketId || !available.some((ticket) => ticket.id === selectedTicketId))) {
      setSelectedTicketId(available[0]?.id || '');
    }
  }, [supportTickets, selectedTicketId, viewingNewRequest]);
  const activeTicket = user && !viewingNewRequest ? tickets.find((ticket) => ticket.id === selectedTicketId) : null;
  const transcript = activeTicket?.conversation || messages;

  function startNewRequest() {
    if (loading || busy) return;
    setViewingNewRequest(true);
    setSelectedTicketId('');
    setDraft('');
    setNotice('Started a new conversation. Previous support requests remain in your account history.');
    onNewRequest?.();
    setOpen(true);
  }

  async function createHandoff(nextMessages = messages) {
    if (flow.stage !== 'consent' || flow.issue.trim().length < 5) {
      if (flow.stage === 'details') {
        setNotice('Please describe what happened before connecting to a person.');
        return;
      }
      const lastUserMessage = [...messages].reverse().find((message) => message.role === 'user')?.content || '';
      const seededIssue = isSupportConcern(lastUserMessage) ? lastUserMessage : '';
      onSetMessages([...messages, { role: 'assistant', content: seededIssue ? 'Before I connect you, please tell me specifically what happened so I can include the right details.' : 'I can connect you with a person. First, what issue should I share with the support team?' }]);
      onFlowChange({ stage: 'details', issue: seededIssue });
      setNotice('');
      return;
    }
    if (!user) {
      setNotice('Sign in to share this issue with a person. Your conversation will stay here.');
      return;
    }
    setBusy(true); setNotice('');
    try {
      const ticket = await onHandoff(nextMessages, flow.issue);
      setViewingNewRequest(false);
      setSelectedTicketId(ticket.id);
      setNotice('Your issue was sent to human support. Continue the conversation here.');
      onFlowChange({ stage: 'thread', issue: flow.issue });
    } catch (error) { setNotice(error.message); }
    finally { setBusy(false); }
  }
  async function submit(event) {
    event.preventDefault();
    const content = draft.trim();
    if (!content || loading || busy) return;
    setDraft(''); setNotice('');
    if (activeTicket) {
      setBusy(true);
      try { await onSendSupportMessage(activeTicket.id, content); }
      catch (error) { setNotice(error.message); setDraft(content); }
      finally { setBusy(false); }
      return;
    }
    const next = [...messages, { role: 'user', content }];
    if (flow.stage === 'details') {
      const issue = [flow.issue, content].filter(Boolean).join(' — ').slice(0, 2000);
      onSetMessages([...next, { role: 'assistant', content: 'Thanks for explaining. Would you like me to connect you with a human support person? Reply “yes” or choose Connect me with a person.' }]);
      onFlowChange({ stage: 'consent', issue });
      return;
    }
    if (flow.stage === 'consent' && /^(yes|yeah|yep|sure|please|connect|human|talk to (a )?(person|human)|speak to (a )?(person|human))(\b|\s|[.!])/i.test(content)) {
      onSetMessages(next);
      await createHandoff(next);
      return;
    }
    if (flow.stage === 'consent' && /^(no|nope|not now|not yet|keep helping|continue with ai)(\b|\s|[.!])/i.test(content)) {
      onFlowChange({ stage: 'idle', issue: '' });
      await onSend(next);
      return;
    }
    if (flow.stage === 'consent') {
      const issue = [flow.issue, content].filter(Boolean).join(' — ').slice(0, 2000);
      onSetMessages([...next, { role: 'assistant', content: 'I’ve added that detail. Would you like me to connect you with a human support person? Reply “yes” or choose Connect me with a person.' }]);
      onFlowChange({ stage: 'consent', issue });
      return;
    }
    if (isSupportConcern(content)) {
      const specific = content.trim().split(/\s+/).length >= 12 || /\b(did not|didn't|never|wasn't|late|dirty|charged|wrong|missing|rude|broken|refused|arrived|waited|cancelled|not delivered|no one|stopped|failed)\b/i.test(content);
      onFlowChange({ stage: specific ? 'consent' : 'details', issue: content.slice(0, 2000) });
      onSetMessages([...next, { role: 'assistant', content: specific
        ? 'I’m sorry that happened. I’ve noted the issue. Would you like me to connect you with a human support person? Reply “yes” or choose Connect me with a person.'
        : 'I’m sorry you’re having trouble. What specifically happened with the service? A short description will help me record the issue correctly.' }]);
      return;
    }
    await onSend(next);
  }
  async function refreshTickets() {
    try { setTickets(await onRefreshSupport()); setNotice('Support conversation refreshed.'); }
    catch (error) { setNotice(error.message); }
  }
  return <div className={`chat-widget ${open ? 'chat-widget-open' : ''}`}>
    {open && <section className="chat-panel glass-hover" aria-label="FeedbackHub assistant">
      <header className="chat-panel-head"><div className="chat-panel-title"><strong>{activeTicket ? 'Human support' : 'FeedbackHub assistant'}</strong><small>{activeTicket ? 'Private conversation · Saved in Support sheet' : 'AI support · Private chat'}</small></div><div className="chat-panel-actions">{user && <button className="chat-new-request" type="button" onClick={startNewRequest} disabled={loading || busy} aria-label="Start a new support request"><span aria-hidden="true">＋</span><span>New request</span></button>}<button type="button" onClick={() => setOpen(false)} aria-label="Close chat">×</button></div></header>
      <div className="chat-messages" aria-live="polite">{transcript.map((message, index) => <div className={`chat-bubble chat-${message.role}`} key={`${index}-${message.content.slice(0, 10)}`}><span>{message.role === 'user' ? 'You' : message.role === 'human' ? 'Support team' : 'Assistant'}</span><p>{message.content}</p></div>)}{loading && <div className="chat-typing">Assistant is replying…</div>}{busy && activeTicket && <div className="chat-typing">Saving to your support conversation…</div>}</div>
      {activeTicket && <div className="chat-ticket-summary"><strong>Support request:</strong> {activeTicket.status} <button type="button" onClick={refreshTickets}>Refresh</button></div>}
      {notice && <p className="chat-notice" role="status">{notice}{!user && <button type="button" onClick={() => onNavigate?.('login')}>Sign in</button>}</p>}
      <form className="chat-compose" onSubmit={submit}><input value={draft} onChange={(event) => setDraft(event.target.value)} maxLength="1200" placeholder={activeTicket ? 'Message human support…' : 'Ask about feedback…'} aria-label="Your message"/><button type="submit" disabled={loading || busy || !draft.trim()} aria-label="Send message">➤</button></form>
      {!activeTicket && <button className="chat-human-button" type="button" onClick={() => createHandoff()} disabled={busy}>{busy ? 'Sending request…' : flow.stage === 'consent' ? 'Connect me with a person' : 'Talk to a person'}</button>}
    </section>}
    <button className="chat-launcher" type="button" onClick={() => setOpen((value) => !value)} aria-expanded={open} aria-label={open ? 'Close support chat' : 'Open support chat'}><span>{open ? '×' : '✦'}</span>{!open && <span>Chat with us</span>}</button>
  </div>;
}

function isSupportConcern(value) {
  return /\b(i have|i've|my|there is|had a|problem|complaint|complain|not working|wrong with|bad service|unhappy|disappointed|wasn't|didn't|failed|broken|missing|late|dirty|rude|hotel|booking|charged|refund|never arrived)\b/i.test(value);
}

function FeedbackTable({ feedback, onStatusChange, onDelete, admin }) {
  const [actionError, setActionError] = useState('');
  async function changeStatus(id, status) {
    try {
      await onStatusChange(id, status);
      setActionError('');
    } catch (error) {
      setActionError(error.message);
    }
  }
  async function deleteItem(id) {
    try {
      await onDelete(id);
      setActionError('');
    } catch (error) {
      setActionError(error.message);
    }
  }
  if (!feedback.length) return <div className="empty-state"><strong>No feedback found</strong><p>Try another status filter.</p></div>;
  return (
    <div className="feedback-table">
      {actionError && <div className="form-error" role="alert">{actionError}</div>}
      <div className="table-row table-head"><span>Customer</span><span>Feedback</span><span>Rating</span><span>Status</span><span>Actions</span></div>
      {feedback.map((item) => (
        <div className="table-row" key={item.id}>
          <span><strong>{item.userName}</strong><small>{item.category}</small></span>
          <span className="feedback-message">{item.message}</span>
          <span><Stars rating={item.rating} /></span>
          <span><select className="status-select" value={item.status} onChange={(event) => changeStatus(item.id, event.target.value)}><option>Submitted</option><option>In Review</option><option>Resolved</option></select></span>
          <span>{admin && <button className="delete-button" onClick={() => deleteItem(item.id)}>Delete</button>}</span>
        </div>
      ))}
    </div>
  );
}
