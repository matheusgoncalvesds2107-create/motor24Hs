
const { app, BrowserWindow, ipcMain, dialog } = require('electron');
const path = require('path');
const fs = require('fs');
const http = require('http');
const https = require('https');
const { spawn } = require('child_process');
const Store = require('electron-store');
const ffmpegPath = require('ffmpeg-static');

const store = new Store({
  defaults: {
    host: 'sapircast.caster.fm',
    port: 11743,
    mount: '/I3Pqo',
    user: 'source',
    password: '',
    bitrate: '96k',
    songsFolder: '',
    programsFolder: '',
    jinglesFolder: '',
    spokenClock: false,
    stationPresenter: 'Matheus Gonçalves',
    stationVoice: 'Puck',
    autoStart: false
  }
});

const schedule = require('./schedule.json');
let win = null;
let active = false;
let stopping = false;
let sourceReq = null;
let ffmpeg = null;
let lastError = '';
let currentLabel = 'Parado';
let logs = [];
let freeSongsPlayed = 0;
let firstFreeSegment = true;
let pendingFreeInsert = null;
let lastHourlyJingleKey = '';

function log(msg) {
  const line = `[${new Date().toLocaleString('pt-BR')}] ${msg}`;
  logs.push(line);
  if (logs.length > 250) logs = logs.slice(-250);
  console.log(line);
  win?.webContents.send('engine-log', line);
}

function makeWindow() {
  win = new BrowserWindow({
    width: 1080,
    height: 760,
    minWidth: 900,
    minHeight: 650,
    backgroundColor: '#06140e',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false
    }
  });
  win.setMenuBarVisibility(false);
  win.loadFile(path.join(__dirname, 'index.html'));
}

function timeInBrazil() {
  const parts = new Intl.DateTimeFormat('pt-BR', {
    timeZone: schedule.timezone || 'America/Sao_Paulo',
    hour:'2-digit', minute:'2-digit', second:'2-digit',
    hourCycle:'h23'
  }).formatToParts(new Date()).reduce((a,p)=>(a[p.type]=p.value,a),{});
  return `${parts.hour}:${parts.minute}:${parts.second}`;
}

function mins(hm) {
  const [h,m] = hm.split(':').map(Number);
  return h*60+m;
}

function currentProgram() {
  const [h,m,s] = timeInBrazil().split(':').map(Number);
  const sec = h*3600+m*60+s;
  for (const p of schedule.programs) {
    const a = mins(p.start)*60, b = mins(p.end)*60;
    const ok = b>a ? sec>=a && sec<b : (sec>=a || sec<b);
    if (ok) return p;
  }
  return null;
}

function elapsedInProgram(p) {
  const [h,m,s] = timeInBrazil().split(':').map(Number);
  const now=h*3600+m*60+s;
  const start=mins(p.start)*60;
  let e=now-start;
  if(e<0)e+=86400;
  return e;
}

function programDuration(p) {
  const a=mins(p.start), b=mins(p.end);
  return (b>a?b-a:1440-a+b)*60;
}

const EXTS = new Set(['.mp3','.wav','.m4a','.aac','.ogg','.flac','.opus']);

function listAudio(dir) {
  if (!dir || !fs.existsSync(dir)) return [];
  return fs.readdirSync(dir)
    .map(name => ({name, full:path.join(dir,name)}))
    .filter(x => fs.statSync(x.full).isFile() && EXTS.has(path.extname(x.name).toLowerCase()))
    .sort((a,b)=>a.name.localeCompare(b.name,'pt-BR'));
}

function programFile(base, pid, names) {
  const dir = path.join(base || '', pid);
  if (!fs.existsSync(dir)) return null;
  for (const f of listAudio(dir)) {
    const n=path.basename(f.name,path.extname(f.name)).toLowerCase();
    if (names.includes(n)) return f.full;
  }
  return null;
}

function estimateSeconds(file) {
  try {
    const s=fs.statSync(file).size;
    return Math.max(30, Math.round((s*8)/96000));
  } catch { return 240; }
}

function pickSong(folder, elapsed=0) {
  const songs = listAudio(folder);
  if (!songs.length) return null;
  const durations = songs.map(x=>estimateSeconds(x.full));
  const cycle = durations.reduce((a,b)=>a+b,0);
  let t=Math.max(0,Math.floor(elapsed));
  if (cycle>0) t%=cycle;
  for(let i=0;i<songs.length;i++){
    if(t<durations[i]) return {file:songs[i].full, seek:t, max:durations[i]-t, label:songs[i].name};
    t-=durations[i];
  }
  return {file:songs[0].full,seek:0,max:durations[0],label:songs[0].name};
}

function ffprobeDuration(file) {
  return new Promise(resolve=>{
    const p=spawn(ffmpegPath,['-hide_banner','-i',file,'-f','null','-'],{stdio:['ignore','ignore','pipe']});
    let err='';
    p.stderr.on('data',d=>err+=d.toString());
    p.on('close',()=>{
      const m=err.match(/Duration:\s*(\d+):(\d+):([\d.]+)/);
      if(!m)return resolve(1);
      resolve(Number(m[1])*3600+Number(m[2])*60+Number(m[3]));
    });
    p.on('error',()=>resolve(1));
  });
}

async function chooseSegment() {
  const cfg = store.store;
  const p=currentProgram();
  if(!p){
    const insert = await freeRadioInsert(cfg);
    if (insert) return insert;

    const [h,m,s]=timeInBrazil().split(':').map(Number);
    const song=pickSong(cfg.songsFolder,h*3600+m*60+s);
    if(!song)return null;
    freeSongsPlayed++;
    return {...song,label:`Louvor ${freeSongsPlayed}/5 • ${song.label}`};
  }

  freeSongsPlayed = 0;
  firstFreeSegment = true;
  pendingFreeInsert = null;

  const base=cfg.programsFolder;
  const opening=programFile(base,p.id,['abertura','opening']);
  const word=programFile(base,p.id,['palavra','word','palavra-do-dia']);
  const faith=programFile(base,p.id,['mensagem-de-fe','mensagem','faith','fe']);
  const outro=programFile(base,p.id,['encerramento','outro','final']);
  const elapsed=elapsedInProgram(p);
  const total=programDuration(p);

  const od=opening?await ffprobeDuration(opening):0;
  const wd=word?await ffprobeDuration(word):0;
  const fd=faith?await ffprobeDuration(faith):0;
  const xd=outro?await ffprobeDuration(outro):0;

  const wordAt=Math.max(od+1,Math.floor(total*0.25));
  const faithAt=Math.max(wordAt+wd+1,Math.floor(total*0.72));
  const outroAt=outro ? Math.max(faithAt+fd+1,total-xd) : total+1;

  if(opening && elapsed<od) return {file:opening,seek:elapsed,max:od-elapsed,label:p.name+' • Abertura'};
  if(word && elapsed>=wordAt && elapsed<wordAt+wd) return {file:word,seek:elapsed-wordAt,max:wordAt+wd-elapsed,label:p.name+' • Palavra'};
  if(faith && elapsed>=faithAt && elapsed<faithAt+fd) return {file:faith,seek:elapsed-faithAt,max:faithAt+fd-elapsed,label:p.name+' • Mensagem de Fé'};
  if(outro && elapsed>=outroAt && elapsed<outroAt+xd) return {file:outro,seek:elapsed-outroAt,max:outroAt+xd-elapsed,label:p.name+' • Encerramento'};

  let phaseStart=0, phaseEnd=total;
  if(elapsed<wordAt){ phaseStart=od; phaseEnd=wordAt; }
  else if(elapsed<faithAt){ phaseStart=wordAt+wd; phaseEnd=faithAt; }
  else if(elapsed<outroAt){ phaseStart=faithAt+fd; phaseEnd=outroAt; }
  else { phaseStart=outroAt+xd; phaseEnd=total; }

  const song=pickSong(cfg.songsFolder,Math.max(0,elapsed-phaseStart));
  if(!song)return null;
  return {
    file:song.file,
    seek:song.seek,
    max:Math.min(song.max,Math.max(1,phaseEnd-elapsed)),
    label:p.name+' • '+song.label
  };
}


function findJingle(cfg, names) {
  const dir = cfg.jinglesFolder || '';
  if (!dir || !fs.existsSync(dir)) return null;
  const files = listAudio(dir);
  for (const f of files) {
    const base = path.basename(f.name, path.extname(f.name)).toLowerCase();
    if (names.includes(base)) return f.full;
  }
  return null;
}


function hourlyJingle(cfg) {
  const [h] = timeInBrazil().split(':').map(Number);
  const dir = cfg.jinglesFolder || '';
  if (!dir) return null;
  const file = path.join(dir, `hora-${String(h).padStart(2,'0')}.wav`);
  if (!fs.existsSync(file)) return null;

  const day = new Intl.DateTimeFormat('pt-BR',{
    timeZone:schedule.timezone || 'America/Sao_Paulo',
    day:'2-digit',month:'2-digit',year:'numeric'
  }).format(new Date());

  return {file, key:`${day}-${h}`, hour:h};
}

function synthesizeTimeAnnouncement() {
  return new Promise((resolve) => {
    const now = timeInBrazil();
    const [hh, mm] = now.split(':').map(Number);
    const phrase = mm === 0
      ? `Na Web Rádio Vem Comigo Deus, agora são ${hh} horas.`
      : `Na Web Rádio Vem Comigo Deus, agora são ${hh} horas e ${mm} minutos.`;

    const out = path.join(app.getPath('temp'), 'vem-comigo-deus-hora-certa.wav');
    const escaped = phrase.replace(/'/g, "''");
    const ps = `
      Add-Type -AssemblyName System.Speech;
      $s = New-Object System.Speech.Synthesis.SpeechSynthesizer;
      try { $s.SelectVoiceByHints([System.Speech.Synthesis.VoiceGender]::Female) } catch {}
      $s.SetOutputToWaveFile('${out.replace(/\\/g,'\\\\')}');
      $s.Speak('${escaped}');
      $s.Dispose();
    `;
    const p = spawn('powershell.exe', ['-NoProfile','-ExecutionPolicy','Bypass','-Command', ps], {windowsHide:true});
    p.on('close', code => resolve(code === 0 && fs.existsSync(out) ? out : null));
    p.on('error', () => resolve(null));
  });
}

async function freeRadioInsert(cfg) {
  if (pendingFreeInsert) {
    const p = pendingFreeInsert;
    pendingFreeInsert = null;
    return p;
  }

  if (firstFreeSegment) {
    firstFreeSegment = false;
    const entry = findJingle(cfg, ['entrada-no-ar','entrada']);
    if (entry) {
      return {
        file:entry, seek:0, max:await ffprobeDuration(entry),
        label:'Matheus Gonçalves • Entrando no ar'
      };
    }
  }

  // Uma vinheta de hora certa por hora, sem repetir.
  const hj = hourlyJingle(cfg);
  if (hj && hj.key !== lastHourlyJingleKey) {
    lastHourlyJingleKey = hj.key;
    return {
      file:hj.file,
      seek:0,
      max:await ffprobeDuration(hj.file),
      label:`Matheus Gonçalves • Hora certa ${String(hj.hour).padStart(2,'0')}:00`
    };
  }

  // Identificação após cada bloco de 5 louvores.
  if (freeSongsPlayed >= 5) {
    freeSongsPlayed = 0;
    const id = findJingle(cfg, ['identificacao','vinheta','id-radio']);
    const back = findJingle(cfg, ['retorno-louvores','retorno']);

    if (id) {
      if (back) {
        pendingFreeInsert = {
          file:back, seek:0, max:await ffprobeDuration(back),
          label:'Matheus Gonçalves • Retorno aos louvores'
        };
      }
      return {
        file:id, seek:0, max:await ffprobeDuration(id),
        label:'Matheus Gonçalves • Web Rádio Vem Comigo Deus'
      };
    }

    if (back) {
      return {
        file:back, seek:0, max:await ffprobeDuration(back),
        label:'Matheus Gonçalves • Retorno aos louvores'
      };
    }
  }

  return null;
}

function stopEngine() {
  stopping=true;
  active=false;
  try{ffmpeg?.kill('SIGKILL')}catch{}
  ffmpeg=null;
  try{sourceReq?.destroy()}catch{}
  sourceReq=null;
  currentLabel='Parado';
  log('Transmissão parada.');
}

function playSegment(seg, req, bitrate) {
  return new Promise((resolve,reject)=>{
    const args=['-hide_banner','-loglevel','error','-re'];
    if(seg.seek>0)args.push('-ss',String(seg.seek));
    args.push('-i',seg.file);
    if(seg.max>0)args.push('-t',String(Math.max(1,Math.ceil(seg.max))));
    args.push('-vn','-ac','2','-ar','44100','-c:a','libmp3lame','-b:a',bitrate||'96k','-f','mp3','pipe:1');
    const p=spawn(ffmpegPath,args,{stdio:['ignore','pipe','pipe']});
    ffmpeg=p;
    let stderr='';
    p.stderr.on('data',d=>stderr+=d.toString());
    p.stdout.on('data',chunk=>{
      if(!active || stopping) return;
      if(!req.write(chunk)) p.stdout.pause();
    });
    req.on('drain',()=>{try{p.stdout.resume()}catch{}});
    p.on('error',reject);
    p.on('close',code=>{
      ffmpeg=null;
      if(!active || stopping || code===0 || code===255) return resolve();
      reject(new Error('FFmpeg código '+code+' '+stderr.slice(-300)));
    });
  });
}

async function runEngine() {
  const cfg=store.store;
  if(!cfg.password) throw new Error('Informe a senha SOURCE do Caster.');
  if(!cfg.songsFolder) throw new Error('Escolha a pasta dos louvores.');
  if(!cfg.programsFolder) throw new Error('Escolha a pasta dos programas.');

  const useTls = Number(cfg.port)===443;
  const transport=useTls?https:http;
  const auth=Buffer.from((cfg.user||'source')+':'+cfg.password).toString('base64');

  const req=transport.request({
    hostname:cfg.host,
    port:Number(cfg.port),
    path:String(cfg.mount||'/').startsWith('/')?cfg.mount:'/'+cfg.mount,
    method:'PUT',
    headers:{
      'Authorization':'Basic '+auth,
      'Content-Type':'audio/mpeg',
      'User-Agent':'Motor24H-Windows/1.0',
      'Ice-Name':'Web Rádio Vem Comigo Deus',
      'Ice-Public':'0',
      'Transfer-Encoding':'chunked',
      'Connection':'keep-alive'
    }
  });
  sourceReq=req;

  let requestError=null;
  req.on('response',res=>{
    log('Caster respondeu HTTP '+res.statusCode);
    res.on('data',()=>{});
  });
  req.on('error',e=>requestError=e);

  while(active && !stopping){
    if(requestError) throw requestError;
    const seg=await chooseSegment();
    if(!seg){
      currentLabel='Sem áudio';
      log('Nenhum áudio encontrado.');
      await new Promise(r=>setTimeout(r,3000));
      continue;
    }
    currentLabel=seg.label;
    win?.webContents.send('current-label',currentLabel);
    log('NO AR: '+seg.label);
    await playSegment(seg,req,cfg.bitrate);
  }
  try{req.end()}catch{}
}

function startEngine() {
  if(active)return;
  stopping=false;
  active=true;
  lastError='';
  logs=[];
  log('Motor 24H iniciado.');
  runEngine().catch(e=>{
    lastError=e.message;
    log('ERRO: '+e.message);
    active=false;
    try{sourceReq?.destroy()}catch{}
    sourceReq=null;
  });
}

ipcMain.handle('get-state',()=>({
  active,lastError,currentLabel,logs:logs.slice(-50),
  config:{...store.store,password:store.get('password')?'********':''},
  currentProgram:currentProgram(),
  now:timeInBrazil()
}));

ipcMain.handle('save-config',(_e,cfg)=>{
  const old=store.store;
  const next={...old,...cfg};
  if(cfg.password==='********' || cfg.password==='') next.password=old.password||'';
  Object.entries(next).forEach(([k,v])=>store.set(k,v));
  return true;
});

ipcMain.handle('choose-songs', async()=>{
  const r=await dialog.showOpenDialog(win,{properties:['openDirectory'],title:'Escolha a pasta dos louvores'});
  if(r.canceled)return '';
  store.set('songsFolder',r.filePaths[0]);
  return r.filePaths[0];
});

ipcMain.handle('choose-jingles', async()=>{
  const r=await dialog.showOpenDialog(win,{properties:['openDirectory'],title:'Escolha a pasta das vinhetas'});
  if(r.canceled)return '';
  store.set('jinglesFolder',r.filePaths[0]);
  return r.filePaths[0];
});

ipcMain.handle('choose-programs', async()=>{
  const r=await dialog.showOpenDialog(win,{properties:['openDirectory'],title:'Escolha a pasta dos programas'});
  if(r.canceled)return '';
  store.set('programsFolder',r.filePaths[0]);
  return r.filePaths[0];
});

ipcMain.handle('start-engine',()=>{startEngine();return true});
ipcMain.handle('stop-engine',()=>{stopEngine();return true});

app.whenReady().then(()=>{
  makeWindow();
  if(store.get('autoStart')) setTimeout(startEngine,1500);
});
app.on('window-all-closed',()=>{stopEngine(); if(process.platform!=='darwin') app.quit();});
