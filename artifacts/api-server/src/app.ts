import express, { type Express, type Request, type Response } from "express";
import cors from "cors";
import pinoHttp from "pino-http";
import router from "./routes";
import { logger } from "./lib/logger";

const app: Express = express();

const NAV = `
<nav>
  <div class="nav-inner">
    <a class="nav-brand" href="/">
      <img src="https://mc-heads.net/avatar/DonutSMP/32" alt="" style="border-radius:4px;vertical-align:middle;margin-right:8px;">
      <span>DonutSMP</span> <span class="brand-accent">Stats</span>
    </a>
    <div class="nav-links">
      <a href="/players">Players</a>
      <a href="https://discord.gg/donutsmp" target="_blank">Discord</a>
    </div>
  </div>
</nav>`;

const FOOTER = `
<footer>
  <div class="footer-inner">
    <div class="footer-col">
      <div class="footer-title">DONUT STATS</div>
      <p class="footer-sub">Unofficial stats site for the DonutSMP Minecraft server.</p>
    </div>
    <div class="footer-col">
      <div class="footer-title">LINKS</div>
      <a href="/">Home</a>
      <a href="/players">Players</a>
    </div>
    <div class="footer-col">
      <div class="footer-title">SOCIALS</div>
      <a href="https://discord.gg/donutsmp" target="_blank">Discord</a>
    </div>
    <div class="footer-col">
      <div class="footer-title">ABOUT</div>
      <p class="footer-sub">This site is not affiliated with DonutSMP or Mojang.</p>
    </div>
  </div>
</footer>`;

const BASE_CSS = `
  * { margin:0; padding:0; box-sizing:border-box; }
  html { font-size:16px; }
  body { background:#111214; color:#e8eaed; font-family:'Segoe UI',system-ui,sans-serif; min-height:100vh; display:flex; flex-direction:column; }

  /* NAV */
  nav { background:#161618; border-bottom:1px solid #2a2b2e; position:sticky; top:0; z-index:100; }
  .nav-inner { max-width:1100px; margin:0 auto; padding:0 24px; height:56px; display:flex; align-items:center; justify-content:space-between; }
  .nav-brand { display:flex; align-items:center; text-decoration:none; color:#e8eaed; font-weight:700; font-size:1rem; gap:2px; }
  .nav-brand span { color:#e8eaed; }
  .brand-accent { color:#5b8ef5 !important; }
  .nav-links { display:flex; gap:24px; }
  .nav-links a { color:#b0b4bc; text-decoration:none; font-size:.95rem; transition:color .15s; }
  .nav-links a:hover { color:#e8eaed; }

  /* MAIN */
  main { flex:1; max-width:1100px; width:100%; margin:0 auto; padding:0 24px 60px; }

  /* FOOTER */
  footer { background:#0d0e10; border-top:1px solid #2a2b2e; padding:40px 24px; }
  .footer-inner { max-width:1100px; margin:0 auto; display:grid; grid-template-columns:repeat(auto-fit,minmax(150px,1fr)); gap:32px; }
  .footer-title { font-size:.7rem; font-weight:700; letter-spacing:.1em; color:#666; margin-bottom:12px; }
  .footer-col a { display:block; color:#888; text-decoration:none; font-size:.875rem; margin-bottom:8px; }
  .footer-col a:hover { color:#e8eaed; }
  .footer-sub { color:#555; font-size:.8rem; line-height:1.5; }

  /* BUTTONS */
  .btn { display:inline-flex; align-items:center; gap:8px; padding:12px 24px; border-radius:8px; font-weight:600; font-size:.95rem; text-decoration:none; cursor:pointer; border:none; transition:opacity .15s, transform .1s; }
  .btn:hover { opacity:.9; transform:translateY(-1px); }
  .btn-primary { background:#5b8ef5; color:#fff; }
  .btn-secondary { background:#2a2b2e; color:#e8eaed; }

  /* CARDS */
  .card { background:#1e2025; border:1px solid #2a2b2e; border-radius:12px; padding:20px; }

  /* STAT GRID */
  .stat-grid { display:grid; grid-template-columns:repeat(auto-fill,minmax(160px,1fr)); gap:12px; }
  .stat-card { background:#1e2025; border:1px solid #2a2b2e; border-radius:10px; padding:16px; }
  .stat-label { font-size:.65rem; font-weight:700; letter-spacing:.1em; color:#888; margin-bottom:6px; display:flex; align-items:center; gap:6px; }
  .stat-value { font-size:1.25rem; font-weight:700; color:#5b8ef5; }

  /* BADGES */
  .badge { display:inline-flex; align-items:center; gap:5px; padding:3px 10px; border-radius:999px; font-size:.75rem; font-weight:700; }
  .badge-online { background:#1e4a2e; color:#3ba55c; }
  .badge-offline { background:#2e2022; color:#888; }

  /* INPUT */
  input[type=text] { background:#1e2025; border:1px solid #2a2b2e; border-radius:8px; padding:12px 16px; color:#e8eaed; font-size:1rem; outline:none; }
  input[type=text]:focus { border-color:#5b8ef5; }
  input[type=text]::placeholder { color:#555; }

  /* SKELETON */
  .skeleton { background:linear-gradient(90deg,#1e2025 25%,#25272c 50%,#1e2025 75%); background-size:200% 100%; animation:shimmer 1.4s infinite; border-radius:6px; }
  @keyframes shimmer { 0%{background-position:200% 0} 100%{background-position:-200% 0} }

  .error-msg { color:#f04747; background:#2e1a1a; border:1px solid #4a2020; padding:16px 20px; border-radius:10px; }
`;

function page(title: string, head: string, body: string): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>${title} — Donut Stats</title>
  <style>${BASE_CSS}${head}</style>
</head>
<body>
${NAV}
${body}
${FOOTER}
</body>
</html>`;
}

// ─── Home Page ────────────────────────────────────────────────────────────────
app.get("/", (_req: Request, res: Response) => {
  res.setHeader("Content-Type", "text/html");
  res.send(page("Home", `
    .hero { padding:80px 0 60px; text-align:center; }
    .hero h1 { font-size:3rem; font-weight:800; line-height:1.1; margin-bottom:16px; }
    .hero h1 span { color:#5b8ef5; }
    .hero p { color:#888; font-size:1.05rem; max-width:520px; margin:0 auto 32px; line-height:1.6; }
    .hero-btns { display:flex; gap:12px; justify-content:center; flex-wrap:wrap; }
    .info-row { display:grid; grid-template-columns:1fr 1fr; gap:16px; margin:48px 0; }
    @media(max-width:600px){ .info-row{grid-template-columns:1fr;} .hero h1{font-size:2rem;} }
    .info-card { display:flex; align-items:center; gap:16px; }
    .info-icon { width:48px; height:48px; border-radius:12px; background:#1a2035; display:flex; align-items:center; justify-content:center; font-size:1.5rem; flex-shrink:0; }
    .info-card h3 { font-size:.85rem; color:#888; margin-bottom:4px; }
    .info-card .big { font-size:1.6rem; font-weight:800; color:#5b8ef5; }
    .info-card .small { font-size:1rem; color:#888; }
    .section-title { font-size:1.4rem; font-weight:700; margin-bottom:20px; }
    .explore-grid { display:grid; grid-template-columns:1fr 1fr; gap:16px; }
    @media(max-width:600px){ .explore-grid{grid-template-columns:1fr;} }
    .explore-card { background:#1e2025; border:1px solid #2a2b2e; border-radius:12px; padding:24px; text-decoration:none; color:inherit; transition:border-color .15s; }
    .explore-card:hover { border-color:#5b8ef5; }
    .explore-card h3 { color:#5b8ef5; font-size:1.05rem; margin-bottom:8px; }
    .explore-card p { color:#888; font-size:.875rem; line-height:1.5; }
  `, `<main>
    <div class="hero">
      <h1>Premium stats for <span>DonutSMP</span></h1>
      <p>Search any player to view their money, shards, playtime, kills, blocks and more — all from the official DonutSMP API.</p>
      <div class="hero-btns">
        <a class="btn btn-primary" href="/players">Search Players →</a>
      </div>
    </div>

    <div class="info-row">
      <div class="card info-card">
        <div class="info-icon">🎮</div>
        <div>
          <h3>Players online now</h3>
          <div><span class="big" id="online-count">—</span> <span class="small">/ 35000</span></div>
          <div style="font-size:.75rem;color:#555;margin-top:2px;">Live from DonutSMP</div>
        </div>
      </div>
      <div class="card info-card" style="cursor:pointer;" onclick="window.open('https://discord.gg/donutsmp','_blank')">
        <div class="info-icon" style="background:#1a1e35;">💬</div>
        <div>
          <h3>Join our Discord</h3>
          <div style="color:#888;font-size:.875rem;line-height:1.4;margin-top:2px;">Community, updates and support. Click to join the server.</div>
        </div>
      </div>
    </div>

    <div class="section-title" style="margin-top:16px;">Explore Donut Stats</div>
    <div class="explore-grid">
      <a class="explore-card" href="/players">
        <h3>Players</h3>
        <p>Search by username. View money, shards, playtime, kills, deaths, blocks and shop activity.</p>
      </a>
      <div class="explore-card" style="opacity:.5;cursor:default;">
        <h3>Leaderboards</h3>
        <p>Coming soon — top players by money, playtime, kills and more.</p>
      </div>
    </div>
  </main>
  <script>
    fetch('/api/donut/online').then(r=>r.json()).then(d=>{
      const el=document.getElementById('online-count');
      if(el && d && (d.online!=null||d.count!=null||d.result!=null)){
        el.textContent=(d.online??d.count??d.result??'N/A').toLocaleString();
      }
    }).catch(()=>{});
  </script>`));
});

// ─── Players Page ─────────────────────────────────────────────────────────────
app.get("/players", (_req: Request, res: Response) => {
  res.setHeader("Content-Type", "text/html");
  res.send(page("Players", `
    .page-header { padding:48px 0 32px; text-align:center; }
    .page-header h1 { font-size:2.2rem; font-weight:800; margin-bottom:8px; }
    .page-header p { color:#888; }
    .search-bar { display:flex; gap:8px; max-width:520px; margin:28px auto 0; }
    .search-bar input { flex:1; }
    .popular-section { margin-top:48px; }
    .popular-title { font-size:1rem; font-weight:700; margin-bottom:4px; }
    .popular-sub { color:#888; font-size:.825rem; margin-bottom:16px; }
    .popular-grid { display:flex; flex-wrap:wrap; gap:10px; }
    .player-chip { display:flex; align-items:center; gap:10px; background:#1e2025; border:1px solid #2a2b2e; border-radius:10px; padding:10px 14px; text-decoration:none; color:inherit; transition:border-color .15s; min-width:180px; cursor:pointer; }
    .player-chip:hover { border-color:#5b8ef5; }
    .player-chip img { border-radius:4px; }
    .player-chip .pname { font-weight:600; font-size:.95rem; }
    .player-chip .psub { color:#888; font-size:.75rem; margin-top:2px; }
    #search-result { margin-top:32px; }
  `, `<main>
    <div class="page-header">
      <h1>Players</h1>
      <p>Search for a player by username to view their stats.</p>
    </div>
    <div class="search-bar">
      <input type="text" id="q" placeholder="Username..." autocomplete="off">
      <button class="btn btn-primary" onclick="goSearch()">Search</button>
    </div>
    <div id="search-result"></div>
    <div class="popular-section">
      <div class="popular-title">Popular players</div>
      <div class="popular-sub">Click to view profile</div>
      <div class="popular-grid" id="popular-grid">
        ${["DrDonutt","archivePedro","JojoJules","Technoblade","Dream"].map(n=>`
          <a class="player-chip" href="/player/${n}">
            <img src="https://mc-heads.net/avatar/${n}/36" width="36" height="36" alt="">
            <div><div class="pname">${n}</div><div class="psub">Click to view stats</div></div>
          </a>`).join("")}
      </div>
    </div>
  </main>
  <script>
    const q=document.getElementById('q');
    q.addEventListener('keydown',e=>{ if(e.key==='Enter') goSearch(); });
    function goSearch(){
      const v=q.value.trim();
      if(v) window.location.href='/player/'+encodeURIComponent(v);
    }
  </script>`));
});

// ─── Player Profile Page ──────────────────────────────────────────────────────
app.get("/player/:username", async (req: Request, res: Response) => {
  const username = req.params["username"]!.trim();
  res.setHeader("Content-Type", "text/html");
  res.send(page(`${username}`, `
    .profile-wrap { padding:40px 0; }
    .profile-top { display:flex; gap:28px; align-items:flex-start; margin-bottom:36px; }
    .skin-wrap { flex-shrink:0; background:#1e2025; border:1px solid #2a2b2e; border-radius:12px; padding:12px; display:flex; align-items:flex-end; justify-content:center; width:130px; min-height:200px; }
    .profile-info { flex:1; padding-top:8px; }
    .profile-name { font-size:2rem; font-weight:800; margin-bottom:10px; display:flex; align-items:center; gap:10px; flex-wrap:wrap; }
    .profile-badges { display:flex; gap:8px; flex-wrap:wrap; margin-bottom:12px; }
    .profile-views { color:#555; font-size:.825rem; }
    .stats-section { margin-top:8px; }
    .stats-title { font-size:1rem; font-weight:700; color:#888; margin-bottom:14px; letter-spacing:.05em; text-transform:uppercase; font-size:.75rem; }
    @media(max-width:580px){ .profile-top{flex-direction:column;} .skin-wrap{width:100%;} }
    .loading { display:flex; flex-direction:column; gap:12px; padding:40px 0; }
    .skel-line { height:20px; border-radius:6px; }
  `, `<main>
    <div class="profile-wrap">
      <div id="root">
        <div class="loading">
          <div class="skeleton skel-line" style="width:200px;height:32px;"></div>
          <div class="stat-grid" style="margin-top:16px;">
            ${Array(8).fill('<div class="skeleton" style="height:80px;border-radius:10px;"></div>').join("")}
          </div>
        </div>
      </div>
    </div>
  </main>
  <script>
    const username=${JSON.stringify(username)};
    function fmtNum(n){
      n=parseFloat(n)||0;
      if(n>=1e9) return (n/1e9).toFixed(2).replace(/\\.?0+$/,'')+'B';
      if(n>=1e6) return (n/1e6).toFixed(2).replace(/\\.?0+$/,'')+'M';
      if(n>=1e3) return (n/1e3).toFixed(2).replace(/\\.?0+$/,'')+'K';
      return n.toFixed(0);
    }
    function fmtPlaytime(ms){
      const s=Math.floor((parseFloat(ms)||0)/1000);
      const d=Math.floor(s/86400);
      const h=Math.floor((s%86400)/3600);
      const m=Math.floor((s%3600)/60);
      if(d>0) return d+'d '+h+'h';
      if(h>0) return h+'h '+m+'m';
      return m+'m';
    }
    function statCard(icon,label,value){
      return '<div class="stat-card"><div class="stat-label">'+icon+' '+label+'</div><div class="stat-value">'+value+'</div></div>';
    }
    async function load(){
      const root=document.getElementById('root');
      try{
        const [statsRes,lookupRes]=await Promise.all([
          fetch('/api/donut/stats/'+encodeURIComponent(username)),
          fetch('/api/donut/lookup/'+encodeURIComponent(username))
        ]);
        const statsJson=await statsRes.json();
        if(!statsRes.ok||!statsJson.result){
          root.innerHTML='<div class="error-msg">❌ Player <strong>'+username+'</strong> not found. Check the spelling and try again.</div>';
          return;
        }
        const r=statsJson.result;
        const online=lookupRes.ok&&(await lookupRes.json().catch(()=>({}))).status===200;
        const loc=online?'Online':'Offline';
        const badgeClass=online?'badge-online':'badge-offline';
        const badgeDot=online?'🟢':'⚫';
        const skinUrl='https://mc-heads.net/body/'+encodeURIComponent(username);
        const money=fmtNum(r.money);
        const shards=fmtNum(r.shards);
        const kills=fmtNum(r.kills);
        const deaths=fmtNum(r.deaths);
        const playtime=fmtPlaytime(r.playtime);
        const placed=fmtNum(r.placed_blocks);
        const broken=fmtNum(r.broken_blocks);
        const mobs=fmtNum(r.mobs_killed);
        const sell=fmtNum(r.money_made_from_sell);
        const shop=fmtNum(r.money_spent_on_shop);
        const kdr=parseFloat(r.deaths)>0?(parseFloat(r.kills)/parseFloat(r.deaths)).toFixed(2):parseFloat(r.kills||0).toFixed(2);
        root.innerHTML=\`
          <div class="profile-top">
            <div class="skin-wrap">
              <img src="\${skinUrl}" alt="\${username} skin" style="max-height:176px;image-rendering:pixelated;" onerror="this.src='https://mc-heads.net/avatar/\${encodeURIComponent(username)}/128'">
            </div>
            <div class="profile-info">
              <div class="profile-name">\${username}</div>
              <div class="profile-badges">
                <span class="badge \${badgeClass}">\${badgeDot} \${loc}</span>
              </div>
              <div class="profile-views" style="margin-bottom:20px;">DonutSMP Player Stats</div>
              <div class="stats-section">
                <div class="stats-title">Statistics</div>
                <div class="stat-grid">
                  \${statCard('💰','MONEY',money)}
                  \${statCard('🔮','SHARDS',shards)}
                  \${statCard('⏱️','PLAYTIME',playtime)}
                  \${statCard('⚔️','KILLS',kills)}
                  \${statCard('💀','DEATHS',deaths)}
                  \${statCard('🗡️','K/D RATIO',kdr)}
                  \${statCard('🧟','MOBS KILLED',mobs)}
                  \${statCard('🪨','BLOCKS BROKEN',broken)}
                  \${statCard('🧱','BLOCKS PLACED',placed)}
                  \${statCard('🟢','EARNED /SELL',sell)}
                  \${statCard('🛒','SPENT /SHOP',shop)}
                </div>
              </div>
            </div>
          </div>\`;
      }catch(e){
        root.innerHTML='<div class="error-msg">❌ Failed to load stats. Please try again.</div>';
      }
    }
    load();
  </script>`));
});

app.use(
  pinoHttp({
    logger,
    serializers: {
      req(req) {
        return { id: req.id, method: req.method, url: req.url?.split("?")[0] };
      },
      res(res) {
        return { statusCode: res.statusCode };
      },
    },
  }),
);
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use("/api", router);

export default app;
