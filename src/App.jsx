import { useEffect, useState } from 'react';

const TOKEN_KEY = 'feedback_session_token';
const MIGRATED_KEY = 'feedback_sheet_migration_complete';

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

  const publicFeedback = feedback.filter((item) => item.status === 'Resolved').sort((a, b) => b.rating - a.rating).slice(0, 3);

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

  async function authenticate(email, password) {
    try {
      const result = await apiRequest('auth/login', { method: 'POST', body: { email, password }, token: '' });
      await enterDashboard(result);
      return { ok: true };
    } catch (error) {
      return { ok: false, error: error.message };
    }
  }

  async function register(name, email, password) {
    try {
      const result = await apiRequest('auth/signup', { method: 'POST', body: { name, email, password }, token: '' });
      await enterDashboard(result);
      return '';
    } catch (error) {
      return error.message;
    }
  }

  async function submitFeedback(item) {
    const result = await apiRequest('feedback', { method: 'POST', body: item });
    setFeedback((items) => [result.feedback, ...items]);
  }

  async function updateFeedbackStatus(id, status) {
    const result = await apiRequest(`feedback/${encodeURIComponent(id)}`, { method: 'PATCH', body: { status } });
    setFeedback((items) => items.map((item) => item.id === id ? result.feedback : item));
  }

  async function deleteFeedback(id) {
    await apiRequest(`feedback/${encodeURIComponent(id)}`, { method: 'DELETE' });
    setFeedback((items) => items.filter((item) => item.id !== id));
  }

  if (view === 'signup') {
    return <AuthPage mode={view} onRegister={register} onNavigate={setView} />;
  }

  if (currentUser?.role === 'admin' && view === 'admin') {
    return <AdminDashboard user={currentUser} feedback={feedback} onStatusChange={updateFeedbackStatus} onDelete={deleteFeedback} onLogout={logout} apiError={apiError} />;
  }

  if (currentUser?.role === 'user' && view === 'user') {
    return <UserDashboard user={currentUser} feedback={feedback} onSubmitFeedback={submitFeedback} onLogout={logout} apiError={apiError} />;
  }

  if (!ready) return <div className="loading-screen">Connecting to FeedbackHub...</div>;

  return (
    <div className="site-shell">
      <header className="topbar">
        <button className="brand" onClick={() => setView('home')}><span className="brand-mark">F</span> FeedbackHub</button>
        <nav>
          <button className="nav-link" onClick={() => document.getElementById('reviews')?.scrollIntoView({ behavior: 'smooth' })}>Reviews</button>
          <button className="button button-ghost" onClick={() => document.getElementById('login-panel')?.scrollIntoView({ behavior: 'smooth' })}>Login</button>
          <button className="button" onClick={() => setView('signup')}>Get started</button>
        </nav>
      </header>

      <main>
        {apiError && <div className="api-notice" role="alert">{apiError}</div>}
        <section className="hero">
          <div>
            <span className="eyebrow">CUSTOMER VOICE PLATFORM</span>
            <h1>Turn honest feedback into better experiences.</h1>
            <p>Share your experience, track support conversations, and help organizations improve what matters most.</p>
            <div className="hero-actions">
              <button className="button button-large" onClick={() => setView('signup')}>Share feedback</button>
              <button className="text-button" onClick={() => document.getElementById('login-panel')?.scrollIntoView({ behavior: 'smooth' })}>Sign in <span>→</span></button>
            </div>
          </div>
          <div className="hero-panel" id="login-panel" aria-label="Login form">
            <div className="panel-heading"><span>Login details</span><span className="live-dot">● Active</span></div>
            <PulseLogin authenticate={authenticate} onNavigate={setView} />
          </div>
        </section>

        <section className="reviews-section" id="reviews">
          <div className="section-heading">
            <div><span className="eyebrow">COMMUNITY VOICES</span><h2>Feedback that makes a difference</h2></div>
            <p>Recent resolved customer experiences.</p>
          </div>
          <div className="review-grid">
            {publicFeedback.map((item) => (
              <article className="review-card" key={item.id}>
                <Stars rating={item.rating} />
                <p>“{item.message}”</p>
                <div><strong>{item.userName}</strong><span>{item.category}</span></div>
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
  const [captcha, setCaptcha] = useState(() => createCaptcha());
  const [captchaAnswer, setCaptchaAnswer] = useState('');

  function refreshCaptcha() {
    setCaptcha(createCaptcha());
    setCaptchaAnswer('');
  }

  async function submit(event) {
    event.preventDefault();
    if (Number(captchaAnswer) !== captcha.answer) {
      setError('Incorrect CAPTCHA answer.');
      refreshCaptcha();
      return;
    }
    const data = new FormData(event.currentTarget);
    const result = await authenticate(data.get('email').trim(), data.get('password'));
    setError(result.ok ? '' : result.error);
    if (!result.ok) refreshCaptcha();
  }

  return (
    <form className="pulse-login" onSubmit={submit}>
      <label>Email address<input name="email" type="email" required placeholder="Enter email" /></label>
      <label>Password<input name="password" type="password" required placeholder="Enter password" /></label>
      <label className="captcha-label">Security check</label>
      <div className="pulse-captcha">
        <span>{captcha.first} + {captcha.second} = ?</span>
        <button type="button" onClick={refreshCaptcha} aria-label="Refresh CAPTCHA">↻</button>
        <input
          type="number"
          required
          value={captchaAnswer}
          onChange={(event) => setCaptchaAnswer(event.target.value)}
          placeholder="Answer"
          aria-label="CAPTCHA answer"
        />
      </div>
      {error && <div className="pulse-login-error" role="alert">{error}</div>}
      <button className="button" type="submit">Login</button>
      <button className="pulse-signup" type="button" onClick={() => onNavigate('signup')}>Create an account</button>
    </form>
  );
}

function AuthPage({ mode, onAuthenticate, onRegister, onNavigate }) {
  const [error, setError] = useState('');
  const [captcha, setCaptcha] = useState(() => createCaptcha());
  const [captchaAnswer, setCaptchaAnswer] = useState('');
  const isLogin = mode === 'login';

  function refreshCaptcha() {
    setCaptcha(createCaptcha());
    setCaptchaAnswer('');
  }

  async function submit(event) {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    if (isLogin) {
      if (Number(captchaAnswer) !== captcha.answer) {
        setError('Incorrect CAPTCHA answer.');
        refreshCaptcha();
        return;
      }
      const result = await onAuthenticate(data.get('email').trim(), data.get('password'));
      setError(result.ok ? '' : result.error);
      if (!result.ok) refreshCaptcha();
      return;
    }
    if (data.get('password').length < 8) return setError('Password must be at least 8 characters.');
    if (data.get('password') !== data.get('confirmPassword')) return setError('Passwords do not match.');
    setError(await onRegister(data.get('name'), data.get('email'), data.get('password')));
  }

  return (
    <main className="auth-page">
      <section className="auth-showcase">
        <button className="brand brand-light" onClick={() => onNavigate('home')}><span className="brand-mark">F</span> FeedbackHub</button>
        <div><span className="eyebrow">FEEDBACK MANAGEMENT</span><h1>{isLogin ? 'Welcome back.' : 'Your voice matters.'}</h1><p>{isLogin ? 'Sign in to manage feedback and follow its progress.' : 'Create an account to submit feedback and track your requests.'}</p></div>
      </section>
      <section className="auth-form-wrap">
        <form className="auth-form" onSubmit={submit}>
          <span className="eyebrow">{isLogin ? 'MEMBER LOGIN' : 'CREATE ACCOUNT'}</span>
          <h2>{isLogin ? 'Sign in' : 'Join FeedbackHub'}</h2>
          {!isLogin && <label>Full name<input name="name" required placeholder="Your name" /></label>}
          <label>Email address<input name="email" type="email" required placeholder="you@example.com" /></label>
          <label>Password<input name="password" type="password" required minLength="8" placeholder="Minimum 8 characters" /></label>
          {!isLogin && <label>Confirm password<input name="confirmPassword" type="password" required placeholder="Repeat password" /></label>}
          {isLogin && (
            <div className="captcha-row">
              <div className="captcha-question" aria-label={`CAPTCHA: ${captcha.first} plus ${captcha.second}`}>
                {captcha.first} + {captcha.second} = ?
              </div>
              <button type="button" className="captcha-refresh" onClick={refreshCaptcha} aria-label="Refresh CAPTCHA">↻</button>
              <input
                value={captchaAnswer}
                onChange={(event) => setCaptchaAnswer(event.target.value)}
                type="number"
                required
                placeholder="Answer"
                aria-label="CAPTCHA answer"
              />
            </div>
          )}
          {error && <div className="form-error" role="alert">{error}</div>}
          <button className="button button-large" type="submit">{isLogin ? 'Sign in' : 'Create account'}</button>
          {isLogin ? <p>Sign in with the administrator account configured for this deployment.</p> : null}
          <div className="auth-switch">{isLogin ? 'New to FeedbackHub?' : 'Already have an account?'} <button type="button" onClick={() => { setError(''); onNavigate(isLogin ? 'signup' : 'login'); }}>{isLogin ? 'Create account' : 'Sign in'}</button></div>
          <button type="button" className="back-link" onClick={() => onNavigate('home')}>← Back to home</button>
        </form>
      </section>
    </main>
  );
}

function createCaptcha() {
  const first = Math.floor(Math.random() * 8) + 1;
  const second = Math.floor(Math.random() * 8) + 1;
  return { first, second, answer: first + second };
}

function DashboardShell({ user, title, subtitle, onLogout, children }) {
  return (
    <div className="dashboard-shell">
      <aside>
        <div className="brand"><span className="brand-mark">F</span> FeedbackHub</div>
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

function AdminDashboard({ user, feedback, onStatusChange, onDelete, onLogout, apiError }) {
  const [filter, setFilter] = useState('All');
  const average = feedback.length ? (feedback.reduce((sum, item) => sum + item.rating, 0) / feedback.length).toFixed(1) : '0.0';
  const visible = filter === 'All' ? feedback : feedback.filter((item) => item.status === filter);

  return (
    <DashboardShell user={user} title="ADMIN MODULE" subtitle="Feedback overview" onLogout={onLogout}>
      {apiError && <div className="api-notice" role="alert">{apiError}</div>}
      <section className="stats-grid">
        <article><span>Total feedback</span><strong>{feedback.length}</strong><small>All submissions</small></article>
        <article><span>Average rating</span><strong>{average}</strong><small>Out of 5.0</small></article>
        <article><span>Awaiting review</span><strong>{feedback.filter((item) => item.status === 'Submitted').length + feedback.filter((item) => item.status === 'In Review').length}</strong><small>Needs attention</small></article>
      </section>
      <section className="content-card">
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

function UserDashboard({ user, feedback, onSubmitFeedback, onLogout, apiError }) {
  const [category, setCategory] = useState('Service');
  const [rating, setRating] = useState(5);
  const [text, setText] = useState('');
  const [done, setDone] = useState(false);
  const myFeedback = feedback.filter((item) => item.userId === user.id).sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));

  async function submit(event) {
    event.preventDefault();
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
    }
  }

  const [submitError, setSubmitError] = useState('');
  return (
    <DashboardShell user={user} title="USER MODULE" subtitle={`Good to see you, ${user.name.split(' ')[0]}`} onLogout={onLogout}>
      {apiError && <div className="api-notice" role="alert">{apiError}</div>}
      <div className="user-layout">
        <section className="content-card feedback-form-card">
          <div className="card-heading"><div><h2>Share feedback</h2><p>Tell us about your recent experience.</p></div></div>
          <form onSubmit={submit}>
            <label>Category<select value={category} onChange={(event) => setCategory(event.target.value)}><option>Service</option><option>Product</option><option>Support</option><option>Website</option><option>Other</option></select></label>
            <label>Rating</label>
            <div className="rating-picker">{[1, 2, 3, 4, 5].map((value) => <button type="button" key={value} className={value <= rating ? 'selected' : ''} onClick={() => setRating(value)}>★</button>)}</div>
            <label>Your feedback<textarea required minLength="10" value={text} onChange={(event) => setText(event.target.value)} placeholder="What went well, or what could be better?" /></label>
            {done && <div className="success-message">Feedback submitted successfully.</div>}
            {submitError && <div className="form-error" role="alert">{submitError}</div>}
            <button className="button button-large" type="submit">Submit feedback</button>
          </form>
        </section>
        <section className="content-card">
          <div className="card-heading"><div><h2>My submissions</h2><p>Track the status of your feedback.</p></div></div>
          {myFeedback.length ? <div className="mobile-feedback-list">{myFeedback.map((item) => <article key={item.id}><div><Stars rating={item.rating} /><span className={`status status-${item.status.toLowerCase().replace(' ', '-')}`}>{item.status}</span></div><p>{item.message}</p><small>{item.category} · {new Date(item.createdAt).toLocaleDateString()}</small></article>)}</div> : <div className="empty-state"><strong>No feedback yet</strong><p>Your submitted feedback will appear here.</p></div>}
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
