import { useEffect, useState } from 'react';

const TOKEN_KEY = 'feedback_session_token';
const MIGRATED_KEY = 'feedback_sheet_migration_complete';
const THEME_KEY = 'feedback_theme_preference';

async function apiRequest(path, { method = 'GET', body, token = localStorage.getItem(TOKEN_KEY) } = {}) {
  const response = await fetch(`/api/${path}`, {
    method,
    headers: {
      ...(body ? { 'Content-Type': 'application/json' } : {}),
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  if (response.status === 204) return null;
  const result = await response.json();
  if (!response.ok) throw new Error(result.error || 'The request could not be completed.');
  return result;
}

function legacyData(key) {
  try {
    const data = JSON.parse(localStorage.getItem(key) || '[]');
    return Array.isArray(data) ? data : [];
  } catch {
    return [];
  }
}

async function migrateLegacyData(token) {
  if (localStorage.getItem(MIGRATED_KEY)) return;
  const users = legacyData('feedback_users');
  const feedback = legacyData('feedback_data');
  if (users.length || feedback.length) {
    await apiRequest('migrate/local-storage', {
      method: 'POST',
      body: { users, feedback },
      token,
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
    async function initialize() {
      try {
        const result = await apiRequest('feedback', { token: '' });
        if (active) setFeedback(result.feedback);
      } catch (error) {
        if (active) setApiError(error.message);
      }

      const token = localStorage.getItem(TOKEN_KEY);
      if (token) {
        try {
          const session = await apiRequest('session', { token });
          if (session.user.role === 'admin') {
            try {
              await migrateLegacyData(token);
            } catch (error) {
              if (active) setApiError(error.message);
            }
          }
          const result = await apiRequest('feedback', { token });
          if (active) {
            setCurrentUser(session.user);
            setFeedback(result.feedback);
            setView(session.user.role === 'admin' ? 'admin' : 'user');
          }
        } catch {
          localStorage.removeItem(TOKEN_KEY);
        }
      }
      if (active) setReady(true);
    }
    initialize();
    return () => { active = false; };
  }, []);

  const publicFeedback = [...feedback].sort((a, b) => b.rating - a.rating);

  function logout() {
    localStorage.removeItem(TOKEN_KEY);
    setCurrentUser(null);
    setApiError('');
    apiRequest('feedback', { token: '' }).then((result) => setFeedback(result.feedback)).catch((error) => setApiError(error.message));
    setView('home');
  }

  async function enterDashboard(result) {
    localStorage.setItem(TOKEN_KEY, result.token);
    setCurrentUser(result.user);
    setView(result.user.role === 'admin' ? 'admin' : 'user');
    setApiError('');
    try {
      if (result.user.role === 'admin') await migrateLegacyData(result.token);
      const data = await apiRequest('feedback', { token: result.token });
      setFeedback(data.feedback);
    } catch (error) {
      setApiError(error.message);
    }
  }

  async function authenticate(email, password, captchaId, captchaAnswer) {
    try {
      const result = await apiRequest('auth/login', { method: 'POST', body: { email, password, captchaId, captchaAnswer }, token: '' });
      await enterDashboard(result);
      return { ok: true };
    } catch (error) {
      return { ok: false, error: error.message };
    }
  }

  async function register(name, email, password, captchaId, captchaAnswer) {
    try {
      const result = await apiRequest('auth/signup', { method: 'POST', body: { name, email, password, captchaId, captchaAnswer }, token: '' });
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
      const result = await apiRequest('feedback', { method: 'POST', body: item });
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

  if (view === 'signup' || view === 'login') {
    return <AuthPage mode={view} theme={theme} onToggleTheme={toggleTheme} onAuthenticate={authenticate} onRegister={register} onNavigate={setView} />;
  }

  if (currentUser?.role === 'admin' && view === 'admin') {
    return <AdminDashboard user={currentUser} feedback={feedback} onStatusChange={updateFeedbackStatus} onDelete={deleteFeedback} onLogout={logout} apiError={apiError} theme={theme} onToggleTheme={toggleTheme} />;
  }

  if (currentUser?.role === 'user' && view === 'user') {
    return <UserDashboard user={currentUser} feedback={feedback} onSubmitFeedback={submitFeedback} onLogout={logout} apiError={apiError} theme={theme} onToggleTheme={toggleTheme} />;
  }

  if (!ready) return <div className="loading-screen">Connecting to FeedbackHub...</div>;

  return (
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
  );
}

function PulseLogin({ authenticate, onNavigate }) {
  const [error, setError] = useState('');
  const [captcha, setCaptcha] = useState(null);
  const [captchaAnswer, setCaptchaAnswer] = useState('');

  async function refreshCaptcha() {
    setCaptchaAnswer('');
    try { setCaptcha(await apiRequest('captcha', { token: '' })); }
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
      <label>Password<input name="password" type="password" required placeholder="Enter password" /></label>
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
    try { setCaptcha(await apiRequest('captcha', { token: '' })); }
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
    if (data.get('password').length < 8) return setError('Password must be at least 8 characters.');
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
          <label>Password<input name="password" type="password" required minLength="8" placeholder="Minimum 8 characters" /></label>
          {!isLogin && <label>Confirm password<input name="confirmPassword" type="password" required placeholder="Repeat password" /></label>}
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
          {isLogin ? <p>Sign in with the administrator account configured for this deployment.</p> : null}
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

function AdminDashboard({ user, feedback, onStatusChange, onDelete, onLogout, apiError, theme, onToggleTheme }) {
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
    </DashboardShell>
  );
}

function UserDashboard({ user, feedback, onSubmitFeedback, onLogout, apiError, theme, onToggleTheme }) {
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
    </DashboardShell>
  );
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
