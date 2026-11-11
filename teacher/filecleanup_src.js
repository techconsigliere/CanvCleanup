/*
 * Canvas Course File Cleanup, teacher-facing bookmarklet (source)
 * Styled to Western Washington University brand guidelines
 * (marcom.wwu.edu/colors, marcom.wwu.edu/typography).
 *
 * Lists every file in the current course, grouped by folder/sub-folder and
 * sorted oldest to newest, flags likely duplicates (Canvas's "name-1.docx"
 * renaming), flags files that are linked from course content, and lets the
 * teacher soft-delete selected files. Deleted files remain restorable via
 * /courses/:id/undelete (subject to that page's limits).
 *
 * Runs in the teacher's own browser session with their own Canvas
 * permissions. No tokens, nothing stored. The only request outside Canvas is
 * the optional brand-font stylesheet from Google Fonts (LOAD_BRAND_FONT).
 */
(async () => {
  'use strict';

  // ---- Configuration -------------------------------------------------------
  // Instructure doesn't officially document /undelete, so point this at a
  // WWU-maintained explainer. Leave '' to hide the link.
  const HELP_URL = '';
  const HELP_LABEL = 'Learn more about restoring deleted items';
  // Loads Fira Sans (WWU's official sans-serif) from Google Fonts. If set to
  // false, or if Canvas's Content Security Policy blocks it, the tool falls
  // back to the system font and still works.
  const LOAD_BRAND_FONT = true;
  // Community reports say Restore Deleted Items lists ~25 recent items per type.
  const UNDELETE_LIST_LIMIT = 25;
  const CONCURRENCY = 4;

  const TOOL_ID = 'cfc-file-cleanup';
  document.getElementById(TOOL_ID)?.remove();
  document.getElementById(TOOL_ID + '-style')?.remove();

  const courseMatch = location.pathname.match(/^\/courses\/(\d+)/);
  if (!courseMatch) {
    alert('Course File Cleanup: open any page inside a Canvas course, then click the bookmarklet again.');
    return;
  }
  const courseId = courseMatch[1];
  const origin = location.origin;
  const courseUrl = `${origin}/courses/${courseId}`;
  const undeleteUrl = `${courseUrl}/undelete`;

  // ---- Small helpers -------------------------------------------------------
  const el = (tag, props = {}, ...kids) => {
    const n = document.createElement(tag);
    for (const [k, v] of Object.entries(props)) {
      if (v == null || v === false) continue;
      if (k === 'text') n.textContent = v;
      else if (k === 'class') n.className = v;
      else if (k.startsWith('on')) n.addEventListener(k.slice(2), v);
      else n.setAttribute(k, v === true ? '' : v);
    }
    for (const kid of kids.flat()) if (kid != null && kid !== false) n.append(kid);
    return n;
  };

  // Inline SVG icons (stroke style, inherit text color). aria-hidden because
  // every icon sits next to visible text or an aria-label.
  const ICONS = {
    close: '<path d="M6 6l12 12M18 6L6 18"/>',
    folder: '<path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/>',
    chevron: '<path d="M6 9l6 6 6-6"/>',
    trash: '<path d="M4 7h16M10 11v6M14 11v6M9 7V4h6v3M6 7l1 13h10l1-13"/>',
    link: '<path d="M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1"/>',
    copy: '<rect x="8" y="8" width="12" height="12" rx="2"/><path d="M16 8V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h2"/>',
    restore: '<path d="M3 12a9 9 0 1 0 3-6.7L3 8M3 3v5h5"/>',
    warn: '<path d="M12 3l10 18H2zM12 10v4M12 17.5v.01"/>',
    check: '<path d="M5 12l5 5L20 7"/>',
    info: '<circle cx="12" cy="12" r="9"/><path d="M12 11v6M12 7.5v.01"/>',
    external: '<path d="M14 4h6v6M20 4l-9 9M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5"/>',
  };
  const icon = (name, size = 18) => {
    const s = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    for (const [k, v] of Object.entries({
      viewBox: '0 0 24 24', width: size, height: size, 'aria-hidden': 'true', focusable: 'false',
      fill: 'none', stroke: 'currentColor', 'stroke-width': '2', 'stroke-linecap': 'round', 'stroke-linejoin': 'round',
    })) s.setAttribute(k, v);
    s.innerHTML = ICONS[name];
    return s;
  };

  // Canvas expects the CSRF token from the _csrf_token cookie on any
  // non-GET request. The cookie value is URI-encoded and may contain '='.
  const csrfToken = () => {
    const c = document.cookie.split('; ').find((x) => x.startsWith('_csrf_token='));
    return c ? decodeURIComponent(c.slice('_csrf_token='.length)) : '';
  };

  const api = async (pathOrUrl, opts = {}) => {
    const url = pathOrUrl.startsWith('http') ? pathOrUrl : origin + pathOrUrl;
    const res = await fetch(url, {
      credentials: 'same-origin',
      ...opts,
      headers: { Accept: 'application/json', 'X-CSRF-Token': csrfToken(), ...(opts.headers || {}) },
    });
    if (!res.ok) {
      const err = new Error(`HTTP ${res.status}`);
      err.status = res.status;
      throw err;
    }
    return res;
  };

  const nextLink = (header) => {
    for (const part of (header || '').split(',')) {
      const m = part.match(/<([^>]+)>;\s*rel="next"/);
      if (m) return m[1];
    }
    return null;
  };

  const getAll = async (path) => {
    const out = [];
    let url = path;
    while (url) {
      const res = await api(url);
      const data = await res.json();
      out.push(...(Array.isArray(data) ? data : [data]));
      url = nextLink(res.headers.get('Link'));
    }
    return out;
  };

  // Run fn over items with limited parallelism so big courses don't hammer Canvas.
  const pool = async (items, limit, fn) => {
    const results = new Array(items.length);
    let i = 0;
    const worker = async () => {
      while (i < items.length) {
        const idx = i++;
        results[idx] = await fn(items[idx], idx);
      }
    };
    await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
    return results;
  };

  const fmtDate = (s) =>
    s ? new Date(s).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' }) : '—';
  const fmtSize = (b) => {
    if (b == null) return '—';
    const u = ['B', 'KB', 'MB', 'GB'];
    let i = 0;
    while (b >= 1024 && i < u.length - 1) { b /= 1024; i++; }
    return `${b.toFixed(i ? 1 : 0)} ${u[i]}`;
  };
  const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;
  const extOf = (name) => {
    const m = name.match(/\.([a-z0-9]{1,5})$/i);
    return m ? m[1].toUpperCase() : 'FILE';
  };

  // ---- Styles (WWU brand) --------------------------------------------------
  // Palette from marcom.wwu.edu/colors. Primary: Dark Blue #003F87, Light Blue
  // #007AC8, White. Accents used sparingly: Light Green #BAD80A, Dark Green
  // #006B3F, Yellow #FFC61E, Red #CC2D30, Black #1C2023, Gray #667986.
  // Tints of light blue and shades of dark blue/gray are permitted.
  // --cfc-gray-dk is a shade of brand gray used for small text on tinted
  // backgrounds, where brand gray falls just under WCAG AA 4.5:1.
  if (LOAD_BRAND_FONT && !document.getElementById(TOOL_ID + '-font')) {
    document.head.append(el('link', {
      id: TOOL_ID + '-font', rel: 'stylesheet',
      href: 'https://fonts.googleapis.com/css2?family=Fira+Sans:wght@400;500;600;700&display=swap',
    }));
  }
  const R = `#${TOOL_ID}`;
  const css = `
${R}{--cfc-dark:#003F87;--cfc-dark-2:#002F66;--cfc-blue:#007AC8;--cfc-tint:#E8F2FA;--cfc-tint-2:#F4F9FD;
--cfc-green:#BAD80A;--cfc-dgreen:#006B3F;--cfc-yellow:#FFC61E;--cfc-red:#CC2D30;--cfc-red-2:#A82326;
--cfc-black:#1C2023;--cfc-gray:#667986;--cfc-gray-dk:#55656F;--cfc-line:#D8E0E6;
--cfc-font:"Fira Sans",system-ui,-apple-system,"Segoe UI",Roboto,"Helvetica Neue",Arial,sans-serif;
position:fixed;inset:0;z-index:100000;display:flex;align-items:center;justify-content:center;padding:2rem 1rem;
background:rgba(0,31,67,.62);backdrop-filter:blur(3px);-webkit-backdrop-filter:blur(3px)}
${R},${R} *,${R} *::before,${R} *::after{box-sizing:border-box;font-family:var(--cfc-font)}
${R} h2,${R} h3,${R} p,${R} ul,${R} table{margin:0;padding:0}
${R} code{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:.88em;background:var(--cfc-tint);color:var(--cfc-dark);padding:.1rem .35rem;border-radius:4px}
${R} a{color:var(--cfc-blue);text-decoration:underline;text-underline-offset:2px}
${R} a:hover{color:var(--cfc-dark)}
${R} :focus-visible{outline:3px solid var(--cfc-blue);outline-offset:2px;border-radius:4px}
${R} [tabindex="-1"]:focus{outline:none}
${R} .cfc-sr{position:absolute!important;width:1px;height:1px;padding:0;margin:-1px;overflow:hidden;clip:rect(0,0,0,0);white-space:nowrap;border:0}
${R} .cfc-hidden{display:none!important}

${R} .cfc-dialog{position:relative;display:flex;flex-direction:column;width:min(1120px,100%);max-height:calc(100vh - 4rem);
background:#fff;color:var(--cfc-black);border-radius:14px;overflow:hidden;box-shadow:0 24px 64px rgba(0,25,55,.45);
animation:cfc-in .22s ease-out}
@keyframes cfc-in{from{opacity:0;transform:translateY(12px) scale(.985)}to{opacity:1;transform:none}}

${R} .cfc-header{display:flex;align-items:flex-start;gap:1rem;padding:1.35rem 1.6rem 1.2rem;color:#fff;
background:linear-gradient(135deg,var(--cfc-dark) 0%,var(--cfc-dark-2) 100%)}
${R} .cfc-eyebrow{font-size:.75rem;font-weight:600;letter-spacing:.12em;text-transform:uppercase;opacity:.9}
${R} .cfc-header h2{font-size:1.65rem;font-weight:600;line-height:1.2;margin:.2rem 0 .35rem;color:#fff}
${R} .cfc-header p{font-size:.95rem;line-height:1.45;max-width:46rem;opacity:.95}
${R} .cfc-x{margin-left:auto;flex:none;display:grid;place-items:center;width:2.5rem;height:2.5rem;border-radius:50%;
border:1.5px solid rgba(255,255,255,.55);background:transparent;color:#fff;cursor:pointer;transition:background .15s}
${R} .cfc-x:hover{background:rgba(255,255,255,.14)}
${R} .cfc-header :focus-visible{outline-color:var(--cfc-green)}
${R} .cfc-key{display:flex;align-items:flex-start;gap:.65rem;margin-top:.7rem;padding:.55rem .75rem;max-width:52rem;
border-radius:8px;background:rgba(255,255,255,.1);border:1px solid rgba(255,255,255,.22);font-size:.88rem;line-height:1.45}
${R} .cfc-key .cfc-badge{flex:none;margin:.05rem 0 0}
${R} .cfc-stripe{height:5px;flex:none;background:var(--cfc-green)}

${R} .cfc-body{flex:1;overflow:auto;padding:1.4rem 1.6rem 1.6rem;scroll-behavior:smooth}
${R} .cfc-loading{display:flex;align-items:center;gap:.8rem;padding:2.5rem 0;justify-content:center;color:var(--cfc-dark);font-weight:500}
${R} .cfc-spin{width:1.4rem;height:1.4rem;border-radius:50%;border:3px solid var(--cfc-tint);border-top-color:var(--cfc-blue);animation:cfc-spin .8s linear infinite;flex:none}
@keyframes cfc-spin{to{transform:rotate(360deg)}}

${R} .cfc-stats{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:.75rem}
${R} .cfc-stat{border:1px solid var(--cfc-line);border-top:4px solid var(--cfc-dark);border-radius:10px;padding:.8rem 1rem;background:#fff}
${R} .cfc-stat b{display:block;font-size:1.75rem;font-weight:700;line-height:1.1;color:var(--cfc-dark)}
${R} .cfc-stat span{font-size:.78rem;font-weight:600;letter-spacing:.06em;text-transform:uppercase;color:var(--cfc-gray)}
${R} .cfc-stat.is-blue{border-top-color:var(--cfc-blue)}
${R} .cfc-stat.is-gray{border-top-color:var(--cfc-gray)}
${R} .cfc-stat.is-yellow{border-top-color:var(--cfc-yellow)}
${R} .cfc-stat.is-green{border-top-color:var(--cfc-dgreen)}
${R} .cfc-note{display:flex;gap:.5rem;align-items:flex-start;margin-top:.9rem;font-size:.88rem;line-height:1.45;color:var(--cfc-gray)}
${R} .cfc-note svg{flex:none;margin-top:.1rem;color:var(--cfc-blue)}

${R} .cfc-banner{display:flex;gap:.75rem;align-items:flex-start;margin-bottom:1rem;padding:.9rem 1rem;border-radius:10px;
background:var(--cfc-tint-2);border:1px solid var(--cfc-line);border-left:5px solid var(--cfc-dgreen);line-height:1.45}
${R} .cfc-banner.is-warn{border-left-color:var(--cfc-red)}
${R} .cfc-banner svg{flex:none;color:var(--cfc-dgreen);margin-top:.1rem}
${R} .cfc-banner.is-warn svg{color:var(--cfc-red)}
${R} .cfc-banner ul{margin:.35rem 0 0 1.1rem;font-size:.9rem}

${R} .cfc-toolbar{display:flex;flex-wrap:wrap;align-items:center;gap:.75rem 1rem;margin:1.25rem 0 .25rem;padding:.75rem 1rem;
background:var(--cfc-tint-2);border:1px solid var(--cfc-line);border-radius:10px}
${R} .cfc-filter{border:0;margin:0;padding:0;min-width:0;display:flex;flex-wrap:wrap;align-items:center;gap:.5rem .75rem}
${R} .cfc-filter legend{float:left;padding:0;font-size:.9rem;font-weight:600;color:var(--cfc-dark)}
${R} .cfc-seg{display:inline-flex;flex-wrap:wrap;border:1.5px solid var(--cfc-blue);border-radius:999px;overflow:hidden;background:#fff}
${R} .cfc-seg label{position:relative;display:inline-flex;align-items:center;gap:.4rem;margin:0;padding:.4rem .9rem;font-size:.88rem;font-weight:500;
color:var(--cfc-dark);cursor:pointer;border-left:1px solid #C7DDEF;transition:background .15s}
${R} .cfc-seg label:first-child{border-left:0}
${R} .cfc-seg label:hover{background:var(--cfc-tint)}
${R} .cfc-seg input{position:absolute;opacity:0;width:1px;height:1px;margin:0;pointer-events:none}
${R} .cfc-seg label:has(input:checked){background:var(--cfc-dark);color:#fff}
${R} .cfc-seg label:has(input:focus-visible){outline:3px solid var(--cfc-green);outline-offset:-3px}
${R} .cfc-n{font-size:.75rem;font-weight:600;padding:0 .45rem;border-radius:999px;background:var(--cfc-tint);color:var(--cfc-dark)}
${R} .cfc-seg label:has(input:checked) .cfc-n{background:#fff;color:var(--cfc-dark)}
${R} .cfc-empty{margin-top:1rem;padding:1.5rem;text-align:center;color:var(--cfc-gray-dk);border:1px dashed var(--cfc-line);border-radius:12px}
${R} .cfc-toolbar .cfc-spacer{flex:1}
${R} .cfc-btn{display:inline-flex;align-items:center;gap:.4rem;padding:.45rem 1rem;border-radius:999px;border:1.5px solid var(--cfc-blue);
background:#fff;color:var(--cfc-dark);font-size:.9rem;font-weight:500;cursor:pointer;transition:background .15s,border-color .15s;line-height:1.3}
${R} .cfc-btn:hover{background:var(--cfc-tint);border-color:var(--cfc-dark)}

${R} .cfc-card{margin-top:1rem;border:1px solid var(--cfc-line);border-radius:12px;overflow:hidden;background:#fff}
${R} .cfc-card-head{display:flex;align-items:center;gap:.75rem;padding:.55rem .9rem;background:var(--cfc-tint);border-bottom:1px solid var(--cfc-line)}
${R} .cfc-card.is-collapsed .cfc-card-head{border-bottom:0}
${R} .cfc-toggle{flex:1;display:flex;align-items:center;gap:.55rem;min-width:0;padding:.3rem .2rem;border:0;background:none;
color:var(--cfc-dark);font-size:1rem;font-weight:600;text-align:left;cursor:pointer}
${R} .cfc-toggle .cfc-path{font-weight:400;color:var(--cfc-gray-dk)}
${R} .cfc-toggle .cfc-chev{margin-left:auto;transition:transform .15s;flex:none}
${R} .cfc-card.is-collapsed .cfc-chev{transform:rotate(-90deg)}
${R} .cfc-count{flex:none;font-size:.78rem;font-weight:600;color:var(--cfc-dark);background:#fff;border:1px solid var(--cfc-line);border-radius:999px;padding:.15rem .6rem}
${R} .cfc-media-note{display:flex;gap:.45rem;align-items:flex-start;padding:.5rem .9rem;font-size:.85rem;line-height:1.45;color:var(--cfc-gray-dk);background:var(--cfc-tint-2);border-bottom:1px solid var(--cfc-line)}
${R} .cfc-media-note svg{flex:none;margin-top:.1rem;color:var(--cfc-dark)}
${R} .cfc-scroll{overflow-x:auto}

${R} table{width:100%;min-width:780px;border-collapse:collapse;table-layout:fixed;font-size:.9rem}
${R} th{padding:.55rem .75rem;text-align:left;font-size:.72rem;font-weight:600;letter-spacing:.06em;text-transform:uppercase;
color:var(--cfc-gray);background:#fff;border-bottom:2px solid var(--cfc-line);white-space:nowrap}
${R} td{padding:.6rem .75rem;border-bottom:1px solid #EDF1F4;vertical-align:top;line-height:1.4}
${R} tbody tr:last-child td{border-bottom:0}
${R} tbody tr{transition:background .12s}
${R} tbody tr:hover{background:var(--cfc-tint-2)}
${R} tbody tr:has(input:checked){background:var(--cfc-tint);box-shadow:inset 4px 0 0 var(--cfc-blue)}
${R} .cfc-cb{width:2.6rem}
${R} input[type=checkbox]:not([role]){width:1.15rem;height:1.15rem;margin:0;accent-color:var(--cfc-blue);cursor:pointer;vertical-align:middle}
${R} .cfc-file{display:flex;gap:.65rem;align-items:flex-start}
${R} .cfc-ext{flex:none;min-width:2.9rem;text-align:center;font-size:.66rem;font-weight:700;letter-spacing:.04em;color:var(--cfc-dark);
background:var(--cfc-tint);border:1px solid #C7DDEF;border-radius:5px;padding:.25rem .3rem;margin-top:.05rem}
${R} .cfc-file label{display:block;font-weight:500;color:var(--cfc-black);cursor:pointer;margin:0;word-break:break-word}
${R} .cfc-open{display:inline-flex;align-items:center;gap:.2rem;font-size:.8rem;margin-top:.15rem}
${R} .cfc-nowrap{white-space:nowrap}
${R} .cfc-pill{display:inline-block;font-size:.75rem;font-weight:600;padding:.12rem .55rem;border-radius:999px;border:1px solid;white-space:nowrap;margin:0 .25rem .25rem 0}
${R} .cfc-pill.is-pub{color:var(--cfc-dgreen);border-color:var(--cfc-dgreen);background:#fff}
${R} .cfc-pill.is-unpub{color:var(--cfc-gray-dk);border-color:#B9C4CC;background:#F3F5F7}
${R} .cfc-pill.is-del{color:#fff;border-color:var(--cfc-gray-dk);background:var(--cfc-gray-dk)}
${R} .cfc-badge{display:inline-flex;align-items:center;gap:.3rem;font-size:.75rem;font-weight:600;padding:.15rem .55rem;border-radius:6px;margin:0 .3rem .3rem 0;white-space:nowrap}
${R} .cfc-badge.is-dup{background:var(--cfc-yellow);color:var(--cfc-black)}
${R} .cfc-badge.is-used{background:var(--cfc-tint);color:var(--cfc-dark);border:1px solid #C7DDEF}
${R} details.cfc-used summary{list-style:none;cursor:pointer;display:inline-block}
${R} details.cfc-used summary::-webkit-details-marker{display:none}
${R} details.cfc-used ul{margin:.2rem 0 .2rem 1rem;font-size:.82rem;color:var(--cfc-gray-dk)}
${R} tr.cfc-deleted td{opacity:.6}
${R} tr.cfc-deleted label{text-decoration:line-through}

${R} .cfc-recover{display:flex;gap:.9rem;margin-top:1.6rem;padding:1.1rem 1.2rem;border-radius:12px;background:var(--cfc-tint-2);
border:1px solid var(--cfc-line);border-left:6px solid var(--cfc-green);line-height:1.55}
${R} .cfc-recover > svg{flex:none;color:var(--cfc-dark);margin-top:.15rem}
${R} .cfc-recover h3{font-size:1.05rem;font-weight:600;color:var(--cfc-dark);margin-bottom:.3rem}
${R} .cfc-recover p + p{margin-top:.5rem}

${R} .cfc-actions{flex:none;padding:.9rem 1.6rem 1rem;background:#fff;border-top:1px solid var(--cfc-line);box-shadow:0 -8px 20px rgba(0,31,67,.07)}
${R} .cfc-actions-row{display:flex;align-items:center;gap:1rem;flex-wrap:wrap}
${R} .cfc-selinfo{font-size:.92rem;color:var(--cfc-gray-dk)}
${R} .cfc-selinfo b{color:var(--cfc-dark)}
${R} .cfc-danger{margin-left:auto;display:inline-flex;align-items:center;gap:.5rem;padding:.7rem 1.35rem;border:0;border-radius:8px;
background:var(--cfc-red);color:#fff;font-size:1rem;font-weight:600;cursor:pointer;transition:background .15s,transform .05s}
${R} .cfc-danger:hover:not([disabled]){background:var(--cfc-red-2)}
${R} .cfc-danger:active:not([disabled]){transform:translateY(1px)}
${R} .cfc-danger[disabled]{background:#E3E8EC;color:var(--cfc-gray-dk);cursor:not-allowed}
${R} .cfc-undo{display:flex;align-items:flex-start;gap:.45rem;margin-top:.65rem;font-size:.86rem;line-height:1.45;color:var(--cfc-gray-dk)}
${R} .cfc-undo svg{flex:none;margin-top:.1rem;color:var(--cfc-dgreen)}
${R} .cfc-progress{height:6px;margin-top:.65rem;border-radius:999px;background:var(--cfc-tint);overflow:hidden}
${R} .cfc-progress span{display:block;height:100%;width:0;background:var(--cfc-blue);transition:width .2s}

${R} .cfc-confirm-wrap{position:absolute;inset:0;z-index:2;display:flex;align-items:center;justify-content:center;padding:1rem;background:rgba(0,31,67,.5)}
${R} .cfc-confirm{width:min(560px,100%);max-height:85%;overflow:auto;background:#fff;border-radius:12px;border-top:6px solid var(--cfc-red);
box-shadow:0 18px 48px rgba(0,25,55,.4);padding:1.3rem 1.4rem;animation:cfc-in .18s ease-out}
${R} .cfc-confirm h3{display:flex;align-items:center;gap:.55rem;font-size:1.25rem;font-weight:600;color:var(--cfc-black)}
${R} .cfc-confirm h3 svg{color:var(--cfc-red)}
${R} .cfc-confirm > p{margin-top:.5rem;line-height:1.5}
${R} .cfc-confirm-list{margin:.75rem 0 0;padding:.5rem .75rem .5rem 1.75rem;max-height:10rem;overflow:auto;font-size:.9rem;
border:1px solid var(--cfc-line);border-radius:8px;background:var(--cfc-tint-2)}
${R} .cfc-alert{display:flex;gap:.6rem;margin-top:.85rem;padding:.75rem .9rem;border-radius:8px;border:1px solid var(--cfc-line);border-left:5px solid var(--cfc-red);font-size:.9rem;line-height:1.45}
${R} .cfc-alert svg{flex:none;color:var(--cfc-red);margin-top:.1rem}
${R} .cfc-alert.is-info{border-left-color:var(--cfc-blue)}
${R} .cfc-alert.is-info svg{color:var(--cfc-blue)}
${R} .cfc-alert ul{margin:.3rem 0 0 1rem}
${R} .cfc-confirm-btns{display:flex;justify-content:flex-end;gap:.75rem;margin-top:1.2rem}
${R} .cfc-confirm-btns .cfc-danger{margin-left:0}

@media (max-width:640px){
  ${R}{padding:0}
  ${R} .cfc-dialog{max-height:100vh;height:100%;border-radius:0}
}
@media (prefers-reduced-motion:reduce){
  ${R} *,${R} *::before{animation:none!important;transition:none!important;scroll-behavior:auto!important}
}
`;
  document.head.append(el('style', { id: TOOL_ID + '-style' }, css));

  // ---- Shell ---------------------------------------------------------------
  const heading = el('h2', { id: TOOL_ID + '-title', tabindex: '-1' }, 'Course File Cleanup');
  const closeBtn = el('button', { class: 'cfc-x', type: 'button', 'aria-label': 'Close Course File Cleanup' }, icon('close', 20));
  const body = el('div', { class: 'cfc-body' });
  const actions = el('div', { class: 'cfc-actions cfc-hidden' });
  let headerText;
  const dialog = el('div', { class: 'cfc-dialog' },
    el('div', { class: 'cfc-header' },
      headerText = el('div', {},
        el('div', { class: 'cfc-eyebrow' }, 'Western Washington University · Canvas Tools'),
        heading,
        el('p', {}, 'Find duplicate and unused files, free up course storage, and keep things tidy. Your files are below, grouped by folder, oldest first.')),
      closeBtn),
    el('div', { class: 'cfc-stripe', 'aria-hidden': 'true' }),
    body,
    actions);
  const overlay = el('div', { id: TOOL_ID, role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': TOOL_ID + '-title' }, dialog);

  let confirmOpen = null; // { box, cancel } while the delete confirmation is showing
  let busy = false;
  const close = () => {
    if (busy && !window.confirm('Files are still being deleted. Close anyway? Deletion will stop partway.')) return;
    overlay.remove();
    document.getElementById(TOOL_ID + '-style')?.remove();
  };
  closeBtn.addEventListener('click', close);
  overlay.addEventListener('click', (e) => { if (e.target === overlay) close(); });

  // Keyboard: Escape closes the confirmation first, then the tool. Tab is kept
  // inside the dialog (or the confirmation) so keyboard users don't wander into
  // the Canvas page underneath. stopPropagation keeps Canvas's own keyboard
  // shortcuts from firing while the tool is open.
  overlay.addEventListener('keydown', (e) => {
    e.stopPropagation();
    if (e.key === 'Escape') {
      e.preventDefault();
      if (confirmOpen) confirmOpen.cancel(); else close();
      return;
    }
    if (e.key !== 'Tab') return;
    const scope = confirmOpen ? confirmOpen.box : dialog;
    const focusables = [...scope.querySelectorAll('a[href],button:not([disabled]),input:not([disabled]),summary')]
      .filter((n) => n.getClientRects().length > 0);
    if (!focusables.length) return;
    const first = focusables[0];
    const last = focusables[focusables.length - 1];
    if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
    else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
  });

  document.body.append(overlay);
  heading.focus();

  const loadingText = el('span', {}, 'Loading course files…');
  const loading = el('div', { class: 'cfc-loading', role: 'status', 'aria-live': 'polite' }, el('div', { class: 'cfc-spin' }), loadingText);
  body.append(loading);
  const fail = (msg) => {
    loading.replaceWith(el('div', { class: 'cfc-banner is-warn', role: 'alert' }, icon('warn', 20), el('div', {}, msg)));
  };

  // ---- Load folders, files, permissions -----------------------------------
  let folders, files, canDelete;
  try {
    [folders, files, canDelete] = await Promise.all([
      getAll(`/api/v1/courses/${courseId}/folders?per_page=100`),
      getAll(`/api/v1/courses/${courseId}/files?per_page=100`),
      api(`/api/v1/courses/${courseId}/permissions?permissions[]=manage_files_delete`)
        .then((r) => r.json())
        .then((p) => !!p.manage_files_delete)
        .catch(() => false),
    ]);
  } catch (e) {
    fail(`Couldn’t load this course’s files (${e.message}). You may not have access to Files in this course.`);
    return;
  }
  if (!files.length) {
    loading.replaceWith(el('div', { class: 'cfc-banner', role: 'status' }, icon('check', 20), el('div', {}, 'This course has no files. Nothing to clean up!')));
    return;
  }

  // ---- Find where files are linked from course content --------------------
  // Maps file id -> Set of places it's referenced ("Page: Week 1", ...).
  const usage = new Map();
  const notChecked = [];
  const fileIdPatterns = [/\/files\/(\d+)/g, /\/media_attachments(?:_iframe)?\/(\d+)/g];
  const addUse = (id, label) => {
    if (!usage.has(id)) usage.set(id, new Set());
    usage.get(id).add(label);
  };
  const recordLinks = (html, label) => {
    if (!html) return;
    for (const re of fileIdPatterns) for (const m of String(html).matchAll(re)) addUse(m[1], label);
  };

  const scans = [
    ['syllabus and course card', async () => {
      const [c] = await getAll(`/api/v1/courses/${courseId}?include[]=syllabus_body&include[]=course_image`);
      recordLinks(c.syllabus_body, 'Syllabus');
      recordLinks(c.image_download_url, 'Course card image');
    }],
    ['pages', async () => {
      for (const p of await getAll(`/api/v1/courses/${courseId}/pages?per_page=100&include[]=body`))
        recordLinks(p.body, `Page: ${p.title}`);
    }],
    ['assignments', async () => {
      for (const a of await getAll(`/api/v1/courses/${courseId}/assignments?per_page=100`))
        recordLinks(a.description, `Assignment: ${a.name}`);
    }],
    ['discussions', async () => {
      for (const d of await getAll(`/api/v1/courses/${courseId}/discussion_topics?per_page=100`))
        recordLinks(d.message, `Discussion: ${d.title}`);
    }],
    ['announcements', async () => {
      for (const d of await getAll(`/api/v1/courses/${courseId}/discussion_topics?only_announcements=true&per_page=100`))
        recordLinks(d.message, `Announcement: ${d.title}`);
    }],
    ['quizzes', async () => {
      const quizzes = await getAll(`/api/v1/courses/${courseId}/quizzes?per_page=100`);
      for (const q of quizzes) recordLinks(q.description, `Quiz: ${q.title}`);
      // Classic Quiz questions keep images and file links in several HTML
      // fields (question text, each answer, and the correct/incorrect/neutral
      // feedback comments). Rather than list every field and risk missing one,
      // stringify the whole question and run the same file-link patterns over
      // it. One request per quiz (more only if a quiz has 100+ questions).
      const failed = [];
      await pool(quizzes, CONCURRENCY, async (q) => {
        try {
          for (const qq of await getAll(`/api/v1/courses/${courseId}/quizzes/${q.id}/questions?per_page=100`))
            recordLinks(JSON.stringify(qq), `Quiz question: ${q.title}`);
        } catch {
          failed.push(q.title);
        }
      });
      if (failed.length) notChecked.push(`questions in ${plural(failed.length, 'quiz')} (${failed.join(', ')})`);
    }],
    ['modules', async () => {
      const mods = await getAll(`/api/v1/courses/${courseId}/modules?per_page=100&include[]=items`);
      await pool(mods, CONCURRENCY, async (mod) => {
        // Canvas omits `items` when a module has many; fetch them separately then.
        const items = mod.items || (await getAll(`/api/v1/courses/${courseId}/modules/${mod.id}/items?per_page=100`));
        for (const it of items) if (it.type === 'File' && it.content_id) addUse(String(it.content_id), `Module: ${mod.name}`);
      });
    }],
  ];

  loadingText.textContent = `Found ${plural(files.length, 'file')}. Checking where they’re linked in your course…`;
  await pool(scans, CONCURRENCY, async ([name, fn]) => {
    try { await fn(); } catch { notChecked.push(name); }
  });

  // ---- Detect duplicates ---------------------------------------------------
  // Canvas renames an upload that collides with an existing name to
  // "name-1.ext", "name-2.ext"; browsers produce "name (1).ext". Strip that
  // suffix to get a key. Only call it a duplicate set when the evidence is
  // decent, so "Lecture-1.pdf" / "Lecture-2.pdf" aren't flagged on name alone.
  const parseName = (name) => {
    const m = name.toLowerCase().trim().match(/^(.*?)(?:-(\d+)| \((\d+)\))?(\.[a-z0-9]{1,6})?$/);
    return { key: `${m[1]}${m[4] || ''}`, suffixed: m[2] != null || m[3] != null };
  };
  const groups = new Map();
  for (const f of files) {
    const p = parseName(f.display_name);
    if (!groups.has(p.key)) groups.set(p.key, []);
    groups.get(p.key).push({ f, suffixed: p.suffixed });
  }
  const dupInfo = new Map(); // file id -> { set, sameSize }
  const dupSets = [];
  for (const members of groups.values()) {
    if (members.length < 2) continue;
    const hasOriginal = members.some((m) => !m.suffixed);
    const names = members.map((m) => m.f.display_name.toLowerCase());
    const identicalNames = new Set(names).size < names.length;
    const sizes = members.map((m) => m.f.size);
    const sharedSize = new Set(sizes).size < sizes.length;
    if (!(hasOriginal || identicalNames || sharedSize)) continue;
    const setNo = dupSets.length + 1;
    const set = members.map((m) => m.f).sort((a, b) => new Date(a.created_at) - new Date(b.created_at));
    dupSets.push(set);
    for (const f of set) dupInfo.set(f.id, { set: setNo, sameSize: sizes.filter((s) => s === f.size).length > 1 });
  }

  // Explain the duplicate badge in the header, but only when there's at least
  // one duplicate set to explain.
  if (dupSets.length) {
    headerText.append(el('p', { class: 'cfc-key', id: 'cfc-dup-key' },
      el('span', { class: 'cfc-badge is-dup' }, icon('copy', 13), 'Duplicate set'),
      el('span', {},
        'Files that share a set number look like copies of the same file, for example, ',
        el('em', {}, 'Syllabus.docx'), ', ', el('em', {}, 'Syllabus-1.docx'), ', and ', el('em', {}, 'Syllabus-2.docx'),
        '. Canvas adds “-1”, “-2” when you upload a file whose name is already in your course. ',
        '“Same size” means the copies are probably identical. Open them to compare, and keep the one you use.')));
  }

  // Folders Canvas fills automatically, whose files are usually embedded
  // somewhere rather than linked by name. Matched on the last path segment,
  // case-insensitively.
  const FOLDER_NOTES = {
    'uploaded media': 'Files in Uploaded Media were usually added through the Rich Content Editor and are often embedded in pages, assignments, or quizzes.',
    'quiz files': 'Files in Quiz Files are usually images or attachments inside quiz questions. Deleting them breaks those questions, in future quizzes and when students review past attempts. Questions pulled from question banks aren’t checked, so leave these alone unless you’re sure.',
  };
  const folderNote = (folder) => folder && FOLDER_NOTES[folder.full_name.split('/').pop().trim().toLowerCase()];

  // ---- Build folder cards --------------------------------------------------
  const folderById = new Map(folders.map((f) => [f.id, f]));
  // A published file inside an unpublished folder (or one whose parent folder
  // is unpublished) still can't be opened by students, so treat it as
  // unpublished for filtering. Walk up parent_folder_id, caching each answer.
  const folderLockCache = new Map();
  const folderUnpublished = (id) => {
    if (id == null) return false;
    if (folderLockCache.has(id)) return folderLockCache.get(id);
    const fo = folderById.get(id);
    const v = !!fo && (!!fo.locked || folderUnpublished(fo.parent_folder_id));
    folderLockCache.set(id, v);
    return v;
  };
  const isUnpublished = (f) => !!f.locked || folderUnpublished(f.folder_id);
  const filesByFolder = new Map();
  for (const f of files) {
    if (!filesByFolder.has(f.folder_id)) filesByFolder.set(f.folder_id, []);
    filesByFolder.get(f.folder_id).push(f);
  }
  for (const list of filesByFolder.values()) list.sort((a, b) => new Date(a.created_at) - new Date(b.created_at));
  const orderedFolderIds = [...filesByFolder.keys()].sort((a, b) =>
    (folderById.get(a)?.full_name || '').localeCompare(folderById.get(b)?.full_name || '', undefined, { numeric: true, sensitivity: 'base' }));

  const byId = new Map(files.map((f) => [f.id, f]));
  const checkboxes = new Map(); // file id -> checkbox
  const rows = new Map(); // file id -> tr
  const cards = [];

  const deleteBtn = el('button', { class: 'cfc-danger', type: 'button', disabled: true }, icon('trash', 18), el('span', {}, 'Delete files'));
  const selInfo = el('div', { class: 'cfc-selinfo', 'aria-live': 'polite' }, 'No files selected');
  const updateSelection = () => {
    const ids = [...checkboxes].filter(([, cb]) => cb.checked && !cb.disabled).map(([id]) => id);
    const bytes = ids.reduce((t, id) => t + (byId.get(id).size || 0), 0);
    deleteBtn.disabled = busy || ids.length === 0;
    deleteBtn.lastChild.textContent = ids.length ? `Delete ${plural(ids.length, 'file')}` : 'Delete files';
    // Files stay selected when a filter or a collapsed folder hides them, so
    // say so; otherwise a teacher could delete files they can no longer see.
    const unseen = ids.filter((id) => rows.get(id)?.getClientRects().length === 0).length;
    selInfo.replaceChildren(ids.length
      ? el('span', {}, el('b', {}, plural(ids.length, 'file')), ` selected · ${fmtSize(bytes)}`,
        unseen > 0 && el('span', {}, ` · ${unseen} not currently shown`))
      : 'No files selected');
  };

  for (const folderId of orderedFolderIds) {
    const folder = folderById.get(folderId);
    const list = filesByFolder.get(folderId);
    const parts = folder ? folder.full_name.split('/').slice(1) : ['Unknown folder'];
    const depth = Math.max(0, parts.length - 1);
    const leaf = parts.length ? parts[parts.length - 1] : 'Files (top level)';
    const parentPath = parts.slice(0, -1).join(' › ');
    const label = parts.length ? parts.join(' › ') : 'Files (top level)';

    const tbody = el('tbody');
    const folderBoxes = [];
    for (const f of list) {
      const used = usage.get(String(f.id));
      const dup = dupInfo.get(f.id);
      const cb = el('input', { type: 'checkbox', id: `cfc-f-${f.id}` });
      cb.disabled = !canDelete;
      cb.addEventListener('change', updateSelection);
      checkboxes.set(f.id, cb);
      folderBoxes.push(cb);

      const pills = [];
      pills.push(f.locked
        ? el('span', { class: 'cfc-pill is-unpub' }, 'Unpublished')
        : folderUnpublished(f.folder_id)
          ? el('span', { class: 'cfc-pill is-unpub', title: 'The file is published, but a folder it’s in is unpublished.' }, 'Unpublished folder')
          : el('span', { class: 'cfc-pill is-pub' }, 'Published'));
      if (f.hidden) pills.push(el('span', { class: 'cfc-pill is-unpub' }, 'Link only'));
      if (f.unlock_at || f.lock_at) pills.push(el('span', { class: 'cfc-pill is-unpub' }, 'Scheduled'));
      const statusCell = el('td', {}, pills);

      const notes = el('td', {},
        dup && el('span', { class: 'cfc-badge is-dup', 'aria-describedby': 'cfc-dup-key' }, icon('copy', 13),
          `Duplicate set ${dup.set}${dup.sameSize ? ' · same size' : ''}`),
        used && el('details', { class: 'cfc-used' },
          el('summary', {}, el('span', { class: 'cfc-badge is-used' }, icon('link', 13), `Linked in ${plural(used.size, 'place')}`)),
          el('ul', {}, [...used].map((u) => el('li', {}, u)))));

      const tr = el('tr', { 'data-dup': dup ? '1' : '0', 'data-unpub': isUnpublished(f) && !used ? '1' : '0' },
        el('td', { class: 'cfc-cb' }, cb),
        el('td', {},
          el('div', { class: 'cfc-file' },
            el('span', { class: 'cfc-ext', 'aria-hidden': 'true' }, extOf(f.display_name)),
            el('div', {},
              el('label', { for: cb.id }, f.display_name),
              el('a', { class: 'cfc-open', href: `${courseUrl}/files/${f.id}`, target: '_blank', rel: 'noopener' },
                'Open', el('span', { class: 'cfc-sr' }, ` ${f.display_name} (opens in a new tab)`), icon('external', 12))))),
        el('td', { class: 'cfc-nowrap' }, fmtDate(f.created_at)),
        el('td', { class: 'cfc-nowrap' }, fmtDate(f.modified_at || f.updated_at)),
        el('td', { class: 'cfc-nowrap' }, fmtSize(f.size)),
        statusCell,
        notes);
      tr._status = statusCell;
      rows.set(f.id, tr);
      tbody.append(tr);
    }

    const allCb = el('input', { type: 'checkbox', 'aria-label': `Select all files in ${label}` });
    allCb.disabled = !canDelete;
    allCb.addEventListener('change', () => {
      for (const cb of folderBoxes) if (!cb.disabled && !cb.closest('tr').classList.contains('cfc-hidden')) cb.checked = allCb.checked;
      updateSelection();
    });

    const regionId = `cfc-region-${folderId}`;
    const toggle = el('button', { type: 'button', class: 'cfc-toggle', 'aria-expanded': 'true', 'aria-controls': regionId },
      icon('folder', 18),
      parentPath && el('span', { class: 'cfc-path' }, `${parentPath} ›`),
      el('span', {}, depth === 0 && !parts.length ? 'Files (top level)' : leaf || 'Files (top level)'),
      icon('chevron', 18));
    toggle.lastChild.classList.add('cfc-chev');

    const region = el('div', { id: regionId },
      folderNote(folder) && el('p', { class: 'cfc-media-note' }, icon('warn', 15), el('span', {}, folderNote(folder))),
      el('div', { class: 'cfc-scroll' },
        el('table', {},
          el('caption', { class: 'cfc-sr' }, `Files in ${label}, oldest first`),
          // Fixed column widths so every folder's table lines up with the others.
          el('colgroup', {}, ['2.6rem', 'auto', '7.5rem', '7.5rem', '5.5rem', '8.5rem', '13.5rem']
            .map((w) => el('col', { style: `width:${w}` }))),
          el('thead', {}, el('tr', {},
            el('th', { class: 'cfc-cb', scope: 'col' }, el('span', { class: 'cfc-sr' }, 'Select')),
            el('th', { scope: 'col' }, 'File'),
            el('th', { scope: 'col' }, 'Uploaded'),
            el('th', { scope: 'col' }, 'Modified'),
            el('th', { scope: 'col' }, 'Size'),
            el('th', { scope: 'col' }, 'Status'),
            el('th', { scope: 'col' }, 'Notes'))),
          tbody)));

    const countPill = el('span', { class: 'cfc-count' }, plural(list.length, 'file'));
    const card = el('section', { class: 'cfc-card', style: `margin-left:${Math.min(depth, 5) * 1.5}rem`, 'aria-label': `Folder: ${label}` },
      el('div', { class: 'cfc-card-head' }, allCb, toggle, countPill),
      region);
    card._count = countPill;
    card._total = list.length;
    card._allCb = allCb;
    toggle.addEventListener('click', () => {
      const open = toggle.getAttribute('aria-expanded') === 'true';
      toggle.setAttribute('aria-expanded', String(!open));
      region.classList.toggle('cfc-hidden', open);
      card.classList.toggle('is-collapsed', open);
    });
    cards.push(card);
  }

  // ---- Summary, toolbar, recovery panel -----------------------------------
  const linkedCount = files.filter((f) => usage.has(String(f.id))).length;
  const totalBytes = files.reduce((t, f) => t + (f.size || 0), 0);
  const stat = (n, label, cls = '') => el('div', { class: `cfc-stat ${cls}` }, el('b', {}, String(n)), el('span', {}, label));
  const stats = el('div', { class: 'cfc-stats' },
    stat(files.length, files.length === 1 ? 'File' : 'Files'),
    stat(orderedFolderIds.length, orderedFolderIds.length === 1 ? 'Folder' : 'Folders', 'is-blue'),
    stat(fmtSize(totalBytes), 'Total size', 'is-gray'),
    stat(dupSets.length, dupSets.length === 1 ? 'Duplicate set' : 'Duplicate sets', 'is-yellow'),
    stat(linkedCount, 'Linked in course', 'is-green'));

  const scopeNote = el('p', { class: 'cfc-note' }, icon('info', 16), el('span', {},
    '“Linked in” means the file is used in your syllabus, pages, assignments, discussions, announcements, quizzes (including quiz questions), or modules, and deleting it will break that link. New Quizzes, question banks, rubrics, calendar events, and external tools aren’t checked.' +
    (notChecked.length ? ` We couldn’t check: ${notChecked.join(', ')}.` : '')));

  const unpubUnlinked = files.filter((f) => isUnpublished(f) && !usage.has(String(f.id))).length;
  const FILTERS = [
    ['all', 'All files', files.length],
    ['dup', 'Duplicates', dupInfo.size],
    ['unpub', 'Unpublished, not linked', unpubUnlinked],
  ];
  const emptyMsg = el('p', { class: 'cfc-empty cfc-hidden' }, 'No files match this filter.');
  const selectShownBtn = el('button', { type: 'button', class: 'cfc-btn cfc-hidden' }, icon('check', 16), 'Select all shown');
  let filterMode = 'all';
  let dupBtn = null; // set when the toolbar is built
  const applyFilter = (mode) => {
    filterMode = mode;
    const matches = (tr) => mode === 'all' || (mode === 'dup' ? tr.dataset.dup === '1' : tr.dataset.unpub === '1');
    for (const tr of rows.values()) tr.classList.toggle('cfc-hidden', !matches(tr));
    let anyShown = false;
    for (const c of cards) {
      const shown = c.querySelectorAll('tbody tr:not(.cfc-hidden)').length;
      anyShown ||= shown > 0;
      c.classList.toggle('cfc-hidden', shown === 0);
      c._count.textContent = mode === 'all' ? plural(c._total, 'file') : `${shown} of ${plural(c._total, 'file')}`;
      c._allCb.checked = false;
    }
    emptyMsg.classList.toggle('cfc-hidden', anyShown);
    selectShownBtn.classList.toggle('cfc-hidden', mode !== 'unpub' || !canDelete || !anyShown);
    dupBtn?.classList.toggle('cfc-hidden', mode === 'unpub');
    updateSelection();
  };
  const filterGroup = el('fieldset', { class: 'cfc-filter' },
    el('legend', {}, 'Show'),
    el('div', { class: 'cfc-seg' }, FILTERS.map(([value, text, n]) => {
      const radio = el('input', { type: 'radio', name: 'cfc-filter', value });
      radio.checked = value === 'all';
      radio.addEventListener('change', () => radio.checked && applyFilter(value));
      return el('label', {}, radio, text, el('span', { class: 'cfc-n' }, String(n)));
    })));

  const banner = el('div', { role: 'status', 'aria-live': 'polite' });
  const showBanner = (kind, iconName, ...content) => {
    banner.replaceChildren(el('div', { class: `cfc-banner${kind === 'warn' ? ' is-warn' : ''}` }, icon(iconName, 20), el('div', {}, ...content)));
  };

  const selectOlderDups = () => {
    let n = 0;
    for (const set of dupSets) {
      for (const f of set.slice(0, -1)) { // everything but the newest copy
        const cb = checkboxes.get(f.id);
        if (cb && !cb.disabled && !usage.has(String(f.id))) { cb.checked = true; n++; }
      }
    }
    updateSelection();
    showBanner('ok', 'check', `Selected ${plural(n, 'older duplicate copy')}. Files linked in your course were skipped. Review the selection before deleting.`);
  };
  // Selects only rows the teacher can actually see: rows hidden by the filter
  // or inside a collapsed folder have no layout boxes (getClientRects is empty).
  selectShownBtn.addEventListener('click', () => {
    let n = 0;
    for (const [id, cb] of checkboxes) {
      if (cb.disabled || cb.checked || rows.get(id).getClientRects().length === 0) continue;
      cb.checked = true;
      n++;
    }
    updateSelection();
    showBanner('ok', 'check', `Selected ${plural(n, 'unpublished file')} not linked anywhere the tool checks. Review the selection before deleting.`);
  });
  const clearAll = () => { for (const cb of checkboxes.values()) cb.checked = false; updateSelection(); banner.replaceChildren(); };

  const toolbar = el('div', { class: 'cfc-toolbar' },
    filterGroup,
    el('span', { class: 'cfc-spacer' }),
    canDelete && selectShownBtn,
    dupSets.length > 0 && canDelete && (dupBtn = el('button', { type: 'button', class: 'cfc-btn', onclick: selectOlderDups }, icon('copy', 16), 'Select older duplicate copies')),
    canDelete && el('button', { type: 'button', class: 'cfc-btn', onclick: clearAll }, 'Clear selection'));

  const recover = el('section', { class: 'cfc-recover', id: 'cfc-recover', 'aria-labelledby': 'cfc-recover-h' },
    icon('restore', 26),
    el('div', {},
      el('h3', { id: 'cfc-recover-h' }, 'Deleted files aren’t necessarily gone forever'),
      el('p', {},
        'If you need a file back, add ', el('code', {}, '/undelete'),
        ' to the end of your course home page address to open the Restore Deleted Items page. For this course, that’s ',
        el('a', { href: undeleteUrl, target: '_blank', rel: 'noopener' }, undeleteUrl), '.'),
      el('p', {},
        `That page lists only your most recently deleted items (about ${UNDELETE_LIST_LIMIT} of each type), and restoring isn’t guaranteed. If you delete many files at once, older ones may not appear until you restore some newer ones. A restored file may need to be published again before students can see it.`),
      HELP_URL && el('p', {}, el('a', { href: HELP_URL, target: '_blank', rel: 'noopener' }, HELP_LABEL))));

  loading.replaceWith(banner, stats, scopeNote, toolbar, emptyMsg, ...cards, recover);

  // ---- Action bar (always visible at the bottom) ---------------------------
  const progress = el('div', { class: 'cfc-progress cfc-hidden', role: 'progressbar', 'aria-label': 'Deleting files', 'aria-valuemin': '0', 'aria-valuemax': '100', 'aria-valuenow': '0' }, el('span'));
  actions.append(
    canDelete
      ? el('div', { class: 'cfc-actions-row' }, selInfo, deleteBtn)
      : el('div', { class: 'cfc-actions-row' }, el('span', { class: 'cfc-selinfo' }, 'You can view these files, but your role in this course doesn’t allow deleting them.')),
    progress,
    el('p', { class: 'cfc-undo' }, icon('restore', 16), el('span', {},
      'Deleted files can usually be restored from ',
      el('a', { href: undeleteUrl, target: '_blank', rel: 'noopener' }, 'Restore Deleted Items'),
      ', add ', el('code', {}, '/undelete'), ' to your course home page address. ',
      el('a', { href: '#cfc-recover', onclick: (e) => { e.preventDefault(); recover.scrollIntoView({ block: 'center' }); } }, 'How restoring works'), '.')));
  actions.classList.remove('cfc-hidden');

  // ---- Delete confirmation (in-dialog, replaces window.confirm) ------------
  const confirmDelete = (ids) => new Promise((resolve) => {
    const linked = ids.filter((id) => usage.has(String(id)));
    const cancelBtn = el('button', { type: 'button', class: 'cfc-btn' }, 'Cancel');
    const okBtn = el('button', { type: 'button', class: 'cfc-danger' }, icon('trash', 18), `Delete ${plural(ids.length, 'file')}`);
    const box = el('div', { class: 'cfc-confirm', role: 'alertdialog', 'aria-modal': 'true', 'aria-labelledby': 'cfc-c-title', 'aria-describedby': 'cfc-c-desc' },
      el('h3', { id: 'cfc-c-title' }, icon('trash', 22), `Delete ${plural(ids.length, 'file')}?`),
      el('p', { id: 'cfc-c-desc' }, 'Students will no longer be able to open these files:'),
      el('ul', { class: 'cfc-confirm-list' }, ids.map((id) => el('li', {}, byId.get(id).display_name))),
      linked.length > 0 && el('div', { class: 'cfc-alert', role: 'note' }, icon('warn', 18), el('div', {},
        el('strong', {}, `${plural(linked.length, 'file')} ${linked.length === 1 ? 'is' : 'are'} linked in your course.`),
        ' Those links will stop working:',
        el('ul', {}, linked.map((id) => el('li', {}, byId.get(id).display_name))))),
      ids.length > UNDELETE_LIST_LIMIT && el('div', { class: 'cfc-alert is-info', role: 'note' }, icon('info', 18), el('div', {},
        `Restore Deleted Items shows only about ${UNDELETE_LIST_LIMIT} recent files at a time, so not all of these will be listed there at once.`)),
      el('div', { class: 'cfc-confirm-btns' }, cancelBtn, okBtn));
    const wrap = el('div', { class: 'cfc-confirm-wrap' }, box);
    const finish = (ok) => { wrap.remove(); confirmOpen = null; resolve(ok); if (!ok) deleteBtn.focus(); };
    cancelBtn.addEventListener('click', () => finish(false));
    okBtn.addEventListener('click', () => finish(true));
    wrap.addEventListener('click', (e) => { if (e.target === wrap) finish(false); });
    confirmOpen = { box, cancel: () => finish(false) };
    dialog.append(wrap);
    cancelBtn.focus(); // safest default: Enter cancels
  });

  // ---- Delete --------------------------------------------------------------
  deleteBtn.addEventListener('click', async () => {
    const ids = [...checkboxes].filter(([, cb]) => cb.checked && !cb.disabled).map(([id]) => id);
    if (!ids.length || !(await confirmDelete(ids))) return;

    busy = true;
    updateSelection();
    progress.classList.remove('cfc-hidden');
    const bar = progress.firstChild;
    const failures = [];
    let done = 0;
    deleteBtn.lastChild.textContent = `Deleting 0 of ${ids.length}…`;

    await pool(ids, 3, async (id) => {
      try {
        // Plain DELETE = soft delete, restorable from /undelete.
        // Never add ?replace=true: that permanently overwrites the file's
        // contents and can't be undone.
        await api(`/api/v1/files/${id}`, { method: 'DELETE' });
        const cb = checkboxes.get(id);
        cb.checked = false;
        cb.disabled = true;
        const tr = rows.get(id);
        tr.classList.add('cfc-deleted');
        tr._status.replaceChildren(el('span', { class: 'cfc-pill is-del' }, 'Deleted'));
      } catch (e) {
        const why = e.status === 401 || e.status === 403
          ? 'not allowed (it may be locked by a Blueprint course)'
          : e.message;
        failures.push(`${byId.get(id).display_name}: ${why}`);
      }
      done++;
      const pct = Math.round((done / ids.length) * 100);
      bar.style.width = `${pct}%`;
      progress.setAttribute('aria-valuenow', String(pct));
      deleteBtn.lastChild.textContent = `Deleting ${done} of ${ids.length}…`;
    });

    busy = false;
    progress.classList.add('cfc-hidden');
    const ok = ids.length - failures.length;
    if (failures.length) {
      showBanner('warn', 'warn',
        el('strong', {}, `Deleted ${plural(ok, 'file')}. ${plural(failures.length, 'file')} couldn’t be deleted:`),
        el('ul', {}, failures.map((f) => el('li', {}, f))));
    } else {
      showBanner('ok', 'check', el('strong', {}, `Deleted ${plural(ok, 'file')}.`),
        ' Need one back? Use Restore Deleted Items, details at the bottom of this window.');
    }
    body.scrollTop = 0;
    updateSelection();
  });
})();