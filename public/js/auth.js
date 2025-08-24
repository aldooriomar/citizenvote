// public/js/auth.js
export async function api(url, opts = {}) {
  const res = await fetch(url, {
    credentials: 'include', // <— sends cookie!
    headers: { 'Content-Type': 'application/json', ...(opts.headers || {}) },
    ...opts,
  });
  if (res.status === 401) {
    // not logged in → back to login
    window.location.href = '/login.html';
    return Promise.reject(new Error('Unauthorized'));
  }
  return res;
}

export async function logoutAndGoLogin() {
  try {
    await api('/api/auth/logout', { method: 'POST' });
  } catch (_) {}
  window.location.href = '/login.html';
}
