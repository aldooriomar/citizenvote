<script>
window.CV = {
  $: (sel, root=document) => root.querySelector(sel),
  $$: (sel, root=document) => [...root.querySelectorAll(sel)],
  api: async (url, options={}) => {
    const res = await fetch(url, {
      credentials: 'include',
      headers: { 'Content-Type': 'application/json', ...(options.headers||{}) },
      ...options
    });
    if (res.status === 401) { window.location = '/login.html'; return; }
    return res.json();
  },
  logout: async () => {
    try { await fetch('/api/auth/logout', { method:'POST', credentials:'include' }); } catch {}
    window.location.replace('/login.html');
  },
  shareLink: async (title, url, text='') => {
    try {
      if (navigator.share) {
        await navigator.share({ title, url, text });
        return true;
      }
    } catch {}
    try {
      await navigator.clipboard.writeText(url);
      alert('Link copied to clipboard');
      return true;
    } catch {}
    prompt('Copy this link:', url);
    return false;
  },
  // Simple nav mount (optional)
  mountNav: async () => {
    const el = document.getElementById('nav');
    if (!el) return;
    el.innerHTML = `
      <div class="nav">
        <div class="brand">CitizenVote</div>
        <div class="links">
          <a href="/index.html">Dashboard</a>
          <a href="/admin.html">Admin</a>
          <a href="/candidate.html">Candidates</a>
          <button id="btnLogout" class="btn-link">Logout</button>
        </div>
      </div>`;
    const b = document.getElementById('btnLogout');
    if (b) b.onclick = () => CV.logout();
  }
};
</script>
<style>
/* minimal styles so it looks neat even if your main CSS is different */
.nav{display:flex;justify-content:space-between;align-items:center;padding:12px 16px;background:#0d1320;border-bottom:1px solid #1b2334}
.nav .brand{color:#dce7ff;font-weight:700}
.nav .links{display:flex;gap:12px;align-items:center}
.nav a{color:#bcd4ff;text-decoration:none;padding:6px 10px;border-radius:8px;background:#0f1a2b}
.nav a:hover{background:#12213a}
.btn-link{background:#2f80ed;color:#fff;border:0;padding:6px 12px;border-radius:8px;cursor:pointer}
.btn-link:hover{opacity:.9}
</style>
