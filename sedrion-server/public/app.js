const $=id=>document.getElementById(id);
const esc=s=>String(s).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
async function j(u,body,method){
  const o=(body!==undefined||method)?{method:method||'POST',headers:{'Content-Type':'application/json'},body:body?JSON.stringify(body):undefined}:{};
  const r=await fetch(u,o);
  if(r.status===401&&!u.includes('login')){location.href='/login.html';throw new Error('Signed out')}
  const d=await r.json().catch(()=>({}));
  if(!r.ok)throw new Error(d.error||r.statusText);
  return d;
}
const pct=(t,s)=>{const e=s.empty_mm??500,f=s.full_mm??50;return Math.max(0,Math.min(100,(e-t)/(e-f)*100))};
const tone=p=>p==null?{k:'',w:'No reading',c:'#8a9aa8'}:p>=80?{k:'bad',w:'Needs clearing',c:'var(--bad)'}:p>=50?{k:'warn',w:'Filling',c:'var(--warn)'}:{k:'ok',w:'Normal',c:'var(--ok)'};
const left=h=>h==null?'No prediction yet':h<48?h.toFixed(1)+' hours left':(h/24).toFixed(1)+' days left';
function toast(m){const t=$('toast');t.textContent=m;t.classList.add('on');setTimeout(()=>t.classList.remove('on'),2600)}
async function logout(){await j('/api/logout',null);location.href='/login.html'}
async function who(){const u=await j('/api/me');$('who').textContent=u.username+' ('+u.role+')';return u}
