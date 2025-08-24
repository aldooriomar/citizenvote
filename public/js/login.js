// public/js/login.js — handles login form

(async () => {
  try {
    const me = await fetch('/api/auth/me', { credentials:'include', cache:'no-store' }).then(r=>r.json());
    if (me.ok) location.href = '/';
  } catch {}
})();

const f = document.getElementById('f');
const email = document.getElementById('email');
const pass = document.getElementById('pass');
const btn = document.getElementById('btn');
const err = document.getElementById('err');

f.addEventListener('submit', async (e)=>{
  e.preventDefault();
  err.hidden = true; err.textContent = '';
  btn.disabled = true;

  try{
    const r = await fetch('/api/auth/login', {
      method:'POST',
      headers:{'Content-Type':'application/json'},
      body: JSON.stringify({ email: email.value.trim(), password: pass.value }),
      credentials: 'include'
    });

    const text = await r.text();
    let data;
    try { data = JSON.parse(text); } catch { data = { ok:false, msg:`HTTP ${r.status}\n${text}` }; }

    if (!data.ok) {
      err.textContent = data.msg || 'Login failed';
      err.hidden = false;
      btn.disabled = false;
      return;
    }
    location.href = '/';
  }catch(ex){
    err.textContent = String(ex);
    err.hidden = false;
    btn.disabled = false;
  }
});
