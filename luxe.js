const $=s=>document.querySelector(s);
const money=n=>'$'+Number(n).toLocaleString('es-MX');
const p2=n=>String(n).padStart(2,'0');
const iso=d=>d.getFullYear()+'-'+p2(d.getMonth()+1)+'-'+p2(d.getDate());
const add=n=>{const d=new Date();d.setDate(d.getDate()+n);return iso(d)};
const today=add(0);
const tm=h=>{const[a,b]=h.split(':');return +a*60+ +b};
const fh=m=>p2(Math.floor(m/60))+':'+p2(m%60);
const fd=f=>new Date(f+'T12:00').toLocaleDateString('es-MX',{weekday:'short',day:'numeric',month:'short'});
const OPEN=600,CLOSE=1140; 

const TODAS=['svc','esp','cli','ap','perm'];
const API='http://localhost:3000'; 
const clon=o=>JSON.parse(JSON.stringify(o));
let CACHE={svc:[],esp:[],cli:[],ap:[],perm:[]}; 
let SNAP={};                                    
let listo=false,pendientes=0,cola=Promise.resolve();

const docsDe=(data,k)=>k==='perm'?(data.perm||[]).map(id=>({id})):(data[k]||[]);
function mapa(data){
 const m={};
 TODAS.forEach(k=>{m[k]=new Map();docsDe(data,k).forEach(d=>m[k].set(String(d.id),[d.id,JSON.stringify(d)]))});
 return m;
}
function distinto(a,b){
 return TODAS.some(k=>{
  if(a[k].size!==b[k].size)return true;
  for(const [id,v] of a[k])if(!b[k].has(id)||b[k].get(id)[1]!==v[1])return true;
  return false;
 });
}

function cambios(data){
 const ch={},del={svc:[],perm:[]},nuevos={esp:[],cli:[]};let hay=false;
 TODAS.forEach(k=>{
  const vistos=new Set();
  docsDe(data,k).forEach(d=>{
   const id=String(d.id),s=JSON.stringify(d),prev=SNAP[k].get(id);vistos.add(id);
   if(!prev||prev[1]!==s){(ch[k]=ch[k]||[]).push(d);hay=true;if(!prev&&nuevos[k])nuevos[k].push(d.id)}
  });
  if(del[k])for(const [id,v] of SNAP[k])if(!vistos.has(id)){del[k].push(v[0]);hay=true}
 });
 return hay?{ch,del,nuevos}:null;
}


let _n=0;
const nuevoId=()=>Date.now()*1000+(_n=(_n+1)%1000);

function load(){
 const d=clon(CACHE);d.perm=d.perm||[];
 Object.defineProperty(d,'nid',{get:nuevoId,set(){},enumerable:false,configurable:true});
 return d;
}
function save(){
 let data;try{data=clon(S)}catch(e){return}
 const c=cambios(data);
 CACHE={svc:data.svc||[],esp:data.esp||[],cli:data.cli||[],ap:data.ap||[],perm:data.perm||[]};
 SNAP=mapa(CACHE);
 if(!c)return;
 pendientes++;
 cola=cola.then(async()=>{
  const r=await fetch(API+'/api/db',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(c)});
  if(!r.ok){const d=await r.json().catch(()=>({}));const e=new Error(d.error||'No se pudo guardar en la base de datos');e.recargar=d.recargar;throw e}
 }).catch(e=>{
  toast(e.message==='Failed to fetch'?'Sin conexión con el servidor. Tus cambios no se guardaron.':e.message);
  if(e.recargar)return setTimeout(()=>location.reload(),2500);
  return refrescar(true);
 }).finally(()=>{pendientes--});
}
async function traer(){
 const r=await fetch(API+'/api/db',{cache:'no-store'});
 if(!r.ok)throw new Error('lectura');
 const d=await r.json();
 return{svc:d.svc||[],esp:d.esp||[],cli:d.cli||[],ap:d.ap||[],perm:d.perm||[]};
}
/* vuelve a leer Mongo; devuelve true si había algo distinto */
async function refrescar(forzar){
 if(!forzar&&(!listo||pendientes>0))return false;
 try{
  const d=await traer(),m=mapa(d);
  if(!forzar&&pendientes>0)return false;
  const hubo=distinto(m,SNAP);
  CACHE=d;SNAP=m;
  if(forzar&&U){cerrar();go(view,1)}
  return hubo;
 }catch(e){return false}
}

let S=load();

const svc=id=>S.svc.find(x=>x.id==id),esp=id=>S.esp.find(x=>x.id==id),cli=id=>S.cli.find(x=>x.id==id);
const act=a=>a.est!=='cancelada';
const sorted=l=>[...l].sort((a,b)=>(a.f+a.h).localeCompare(b.f+b.h));
const nextOnes=l=>sorted(l).filter(a=>a.f>=today&&act(a)&&a.est!=='atendida');
const ing=l=>l.filter(a=>a.pago==='pagado').reduce((t,a)=>t+svc(a.sid).p,0);
const debe=a=>act(a)&&a.pago==='pendiente';
const nowMin=()=>new Date().getHours()*60+new Date().getMinutes();
const pasada=a=>a.f<today||(a.f===today&&tm(a.h)+svc(a.sid).d<=nowMin());

/* validación de empalmes y horario del especialista (RF22) */
function libre(eid,f,h,dur,skip){
 const e=esp(eid),i=tm(h),fin=i+dur;
 if(!e||!e.act||i<e.hi||fin>e.hf)return false;
 return !S.ap.some(a=>a.id!==skip&&a.eid==eid&&a.f===f&&act(a)&&i<tm(a.h)+svc(a.sid).d&&tm(a.h)<fin);
}
function horas(eid,f,dur,skip){const e=esp(eid),r=[];for(let m=e.hi;m+dur<=e.hf;m+=30)r.push({h:fh(m),ok:libre(eid,f,fh(m),dur,skip)&&!(f===today&&m<=nowMin())});return r}

function toast(t){const e=$('#toast');e.textContent=t;e.classList.add('show');clearTimeout(toast.t);toast.t=setTimeout(()=>e.classList.remove('show'),3200)}
function modal(h){cerrar();const d=document.createElement('div');d.className='mod';d.innerHTML=`<div class="card" role="dialog" aria-modal="true">${h}</div>`;document.body.appendChild(d)}
function cerrar(){document.querySelectorAll('.mod').forEach(x=>x.remove())}
const tag=(t,c)=>`<span class="tag ${c||''}">${t}</span>`;
const estTag=a=>a.est==='atendida'?tag('Ya pasó','ok'):a.est==='cancelada'?tag('Cancelada','no'):pasada(a)?tag('No se presentó / sin atender','no'):tag(a.est==='confirmada'?'Confirmada':'Por confirmar');
const pagoTag=a=>a.est==='cancelada'&&a.pago==='pendiente'?tag('Sin cobro'):({pagado:tag('Pagado','ok'),pendiente:tag('Debe pago','no'),reembolsado:tag('Reembolsado','ok'),'reembolso pendiente':tag('Reembolso pendiente','no')})[a.pago];
const head=(t,s)=>`<h2>${t}</h2><p class="sub">${s||''}</p>`;
const AVISO={nueva:'Nueva cita agendada',cambio:'Cita reprogramada',cancel:'Cita cancelada',rechazo:'Cancelación no aprobada por administración (la cita sigue activa)'};

/* navegación: cada página define NAV, V, B, LIVE */
let U=null,view='';
const V={},B={};
function go(v,keep){
 S=load();view=v;
 $('#nav').innerHTML=`<div class="brand">Luxe Beauty Bar</div><div class="who">${U.n}</div>`+
  NAV.map(([k,t])=>`<button class="${k===v?'on':''}" data-v="${k}">${t}${typeof BADGE==='function'&&BADGE(k)?' <span class="tag no">'+BADGE(k)+'</span>':''}</button>`).join('')+`<button class="out" id="lo">Cerrar sesión</button>`;
 $('#nav').querySelectorAll('[data-v]').forEach(b=>b.onclick=()=>go(b.dataset.v));
 $('#lo').onclick=()=>{U=null;cerrar();$('#app').classList.add('hide');$('#login').classList.remove('hide');$('#pw').value=''};
 $('#main').innerHTML=V[v]();
 if(B[v])B[v]();if(!keep)window.scrollTo(0,0);
}
function entrar(u,inicio){U=u;$('#login').classList.add('hide');$('#app').classList.remove('hide');go(inicio)}

/* arranque: lee Mongo antes de dejar entrar, y luego revisa cambios cada 5 s */
(async()=>{
 const btn=$('#go');if(btn)btn.disabled=true;
 for(;;){
  try{CACHE=await traer();SNAP=mapa(CACHE);listo=true;break}
  catch(e){toast('No se pudo conectar con el servidor. Reintentando…');await new Promise(r=>setTimeout(r,3000))}
 }
 if(btn)btn.disabled=false;
})();
setInterval(async()=>{
 if(document.hidden)return;
 const hubo=await refrescar();
 if(!hubo||!U||document.querySelector('.mod'))return;
 if(/INPUT|SELECT|TEXTAREA/.test(document.activeElement.tagName))return;
 if(typeof LIVE!=='undefined'&&LIVE.includes(view)){go(view,1);toast('Se actualizó la agenda')}
},5000);
addEventListener('beforeunload',e=>{if(pendientes>0){e.preventDefault();e.returnValue=''}});

/* acciones sobre citas */
const getAp=id=>{S=load();return S.ap.find(x=>x.id==id)};
function reprog(id){
 const a=getAp(id),f=prompt('Nueva fecha (AAAA-MM-DD):',a.f);if(!f)return;
 const h=prompt('Nueva hora (HH:MM):',a.h);if(!h)return;
 if(!/^\d{4}-\d\d-\d\d$/.test(f)||!/^\d\d:\d\d$/.test(h)||f<today)return toast('Fecha u hora no válidas');
 if(!libre(a.eid,f,h,svc(a.sid).d,a.id))return toast('Ese horario se empalma o está fuera del horario de la especialista');
 a.f=f;a.h=h;a.nueva='cambio';delete a.solCancel;save();toast('Cita reprogramada. Se notificó a la clienta y a la especialista.');go(view,1);
}
function cancelar(id,adm){
 const a=getAp(id),r=a.pago==='pagado';
 if(!confirm(r?`¿Cancelar esta cita? Se solicitará el reembolso de ${money(svc(a.sid).p)}.`:'¿Cancelar esta cita?'))return;
 a.est='cancelada';a.nueva='cancel';delete a.solCancel;if(r)a.pago='reembolso pendiente';save();
 toast(adm?(r?'Cita cancelada. Se avisó a la clienta y a la especialista; el reembolso quedó por registrar.':'Cita cancelada. Se avisó a la clienta y a la especialista.'):(r?'Cita cancelada. Tu reembolso quedó solicitado y el salón lo procesará.':'Cita cancelada'));go(view,1);
}
/* la especialista solo SOLICITA: la cita sigue igual para la clienta hasta que administración la cancele */
function solicitarCancel(id){
 const a=getAp(id);if(!a||a.est==='cancelada'||a.est==='atendida'||a.solCancel)return;
 const m=prompt('Motivo de la cancelación (opcional). Se enviará a la administración; la cita sigue activa hasta que ella la cancele.','');
 if(m===null)return;
 a.solCancel={m:m.trim(),t:Date.now()};save();
 toast('Solicitud enviada a la administración. La clienta no verá cambios hasta que la apruebe.');go(view,1);
}
function rechazarCancel(id){
 const a=getAp(id);if(!a||!a.solCancel)return;
 if(!confirm('¿Rechazar la solicitud? La cita se mantiene.'))return;
 delete a.solCancel;a.nueva='rechazo';save();toast('Solicitud rechazada. La cita sigue activa.');go(view,1);
}
function setE(id,e){getAp(id).est=e;save();toast(e==='atendida'?'Cita marcada como atendida':'Cita confirmada');go(view,1)}
function pagar(id){const a=getAp(id);Object.assign(a,{pago:'pagado',metodo:'Pago presencial',fpago:today});save();toast('Pago registrado');go(view,1)}
/* reembolso: pide los datos de la tarjeta/cuenta de la clienta, igual que el pago en línea */
function abrirReembolso(id){
 const a=getAp(id);if(!a||a.pago!=='reembolso pendiente')return;
 const c=cli(a.cli),s=svc(a.sid);
 modal(`<h3>Reembolsar pago</h3><p class="mut">${s.n} con ${esp(a.eid).n} · ${fd(a.f)} ${a.h} h</p>
 <p class="mut" style="margin-top:6px"><b>Clienta:</b> ${c.n}<br>${c.t||'Sin teléfono'} · ${c.c}</p>
 ${a.metodo?`<p class="mut" style="margin-top:6px">Pagó con: ${a.metodo} ${a.tarj||''}</p>`:''}
 <p style="font-family:Marcellus,serif;font-size:26px;color:var(--gold);margin:6px 0">${money(s.p)}</p>
 <label for="rfm">Tipo de tarjeta</label><select id="rfm"><option>Crédito</option><option>Débito</option></select>
 <label for="rfn">Nombre de la titular</label><input id="rfn" autocomplete="off" value="${c.n}">
 <label for="rfc">Número de tarjeta o cuenta de la clienta</label><input id="rfc" inputmode="numeric" autocomplete="off" placeholder="Cualquier número">
 <label for="rfv">Vencimiento</label><input id="rfv" inputmode="numeric" autocomplete="off" placeholder="MM/AA" maxlength="5">
 <p class="mut" style="margin-top:10px">Reembolso de demostración: puedes escribir cualquier número. Solo se guardan los últimos 4 dígitos; el número completo nunca se almacena.</p>
 <div class="acts"><button class="btn o" id="rfno">Cancelar</button><button class="btn" id="rfok">Reembolsar ${money(s.p)}</button></div>`);
 $('#rfc').oninput=e=>e.target.value=e.target.value.replace(/\D/g,'').replace(/(\d{4})(?=\d)/g,'$1 ');
 $('#rfv').oninput=e=>{let v=e.target.value.replace(/\D/g,'').slice(0,4);if(v.length>2)v=v.slice(0,2)+'/'+v.slice(2);e.target.value=v};
 $('#rfno').onclick=cerrar;
 $('#rfok').onclick=()=>{
  const n=$('#rfn').value.trim(),num=$('#rfc').value.replace(/\s/g,''),m=/^(\d\d)\/(\d\d)$/.exec($('#rfv').value);
  if(n.length<3)return toast('Escribe el nombre de la titular');
  if(num.length<4)return toast('Escribe el número de tarjeta o cuenta de la clienta');
  if(!m||+m[1]<1||+m[1]>12)return toast('Fecha de vencimiento no válida');
  const y=2000+ +m[2],d=new Date();
  if(y<d.getFullYear()||(y===d.getFullYear()&&+m[1]<d.getMonth()+1))return toast('La tarjeta está vencida');
  S=load();const x=S.ap.find(q=>q.id==id);
  if(!x||x.pago!=='reembolso pendiente'){cerrar();return go(view,1)}
  Object.assign(x,{pago:'reembolsado',freemb:today,metodoReemb:'Tarjeta de '+$('#rfm').value.toLowerCase(),tarjReemb:'•••• '+num.slice(-4),refReemb:'RB'+String(Date.now()).slice(-6)});
  save();cerrar();toast('Reembolso registrado. Folio '+x.refReemb+'. Se notificó a la clienta.');go(view,1);
 };
 $('#rfn').focus();
}

/* tabla de citas para admin (adm=1) y especialista */
const acciones=(a,adm)=>{
 if(a.est==='cancelada')return adm&&a.pago==='reembolso pendiente'?`<button class="btn s o" onclick="abrirReembolso(${a.id})">Reembolsar</button>`:'';
 if(a.est==='atendida')return '';
 const sol=!!a.solCancel;
 return (a.est==='pendiente'?`<button class="btn s o" onclick="setE(${a.id},'confirmada')">Confirmar</button>`:'')+
 `<button class="btn s" onclick="setE(${a.id},'atendida')">Ya pasó</button>`+
 (adm&&a.pago==='pendiente'?`<button class="btn s o" onclick="pagar(${a.id})">Cobrar</button>`:'')+
 `<button class="btn s o" onclick="reprog(${a.id})">Reprogramar</button>`+
 (adm?(sol?`<button class="btn s bad" onclick="cancelar(${a.id},1)">Aprobar cancelación</button><button class="btn s o" onclick="rechazarCancel(${a.id})">Rechazar</button>`:`<button class="btn s bad" onclick="cancelar(${a.id},1)">Cancelar</button>`)
  :(sol?`<span class="mut">Cancelación en revisión</span>`:`<button class="btn s bad" onclick="solicitarCancel(${a.id})">Solicitar cancelación</button>`));
};
const tabla=(l,adm,verEsp)=>l.length?`<div class="tw"><table><tr><th>Fecha y hora</th><th>Clienta</th><th>Servicio</th>${verEsp?'<th>Especialista</th>':''}<th>Estado</th><th>Pago</th><th></th></tr>${l.map(a=>`<tr><td>${fd(a.f)}<br><b>${a.h}</b></td><td>${cli(a.cli).n}<br><span class="mut">${cli(a.cli).t}</span></td><td>${svc(a.sid).n}<br><span class="mut">${money(svc(a.sid).p)}</span></td>${verEsp?`<td>${esp(a.eid).n}</td>`:''}<td>${estTag(a)}${a.solCancel&&act(a)&&a.est!=='atendida'?'<br>'+tag('Cancelación solicitada','no'):''}</td><td>${pagoTag(a)}${a.metodo?`<br><span class="mut">${a.metodo} ${a.tarj||''}</span>`:''}</td><td>${acciones(a,adm)}</td></tr>`).join('')}</table></div>`:`<div class="card empty">No hay citas con este filtro.</div>`;