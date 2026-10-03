
const $=s=>document.querySelector(s);
let filled=false;
async function refresh(){
  const s=await window.motor.state();
  $('#clock').textContent=s.now;
  $('#live').textContent=s.active?'● NO AR':'● PARADO';
  $('#live').className='badge '+(s.active?'on':'off');
  $('#current').textContent=s.currentLabel||'Louvores que Edificam';
  $('#program').textContent=s.currentProgram?`${s.currentProgram.name} • ${s.currentProgram.host}`:'Fora da programação';
  $('#log').textContent=(s.logs||[]).join('\n')||'Aguardando...';
  if(!filled){
    const c=s.config||{};
    $('#host').value=c.host||'';
    $('#port').value=c.port||'';
    $('#mount').value=c.mount||'';
    $('#user').value=c.user||'source';
    $('#password').value=c.password||'';
    $('#bitrate').value=c.bitrate||'96k';
    $('#songs').value=c.songsFolder||'';
    $('#programs').value=c.programsFolder||'';
    $('#jingles').value=c.jinglesFolder||'';
    $('#spokenClock').checked=false;
    $('#autoStart').checked=!!c.autoStart;
    filled=true;
  }
}
$('#chooseSongs').onclick=async()=>{const p=await window.motor.chooseSongs();if(p)$('#songs').value=p};
$('#choosePrograms').onclick=async()=>{const p=await window.motor.choosePrograms();if(p)$('#programs').value=p};
$('#chooseJingles').onclick=async()=>{const p=await window.motor.chooseJingles();if(p)$('#jingles').value=p};
$('#save').onclick=async()=>{
  await window.motor.save({
    host:$('#host').value.trim(),port:Number($('#port').value),mount:$('#mount').value.trim(),
    user:$('#user').value.trim()||'source',password:$('#password').value,
    bitrate:$('#bitrate').value,songsFolder:$('#songs').value,programsFolder:$('#programs').value,jinglesFolder:$('#jingles').value,spokenClock:$('#spokenClock').checked,
    autoStart:$('#autoStart').checked
  });
  alert('Configuração salva neste Windows.');
};
$('#start').onclick=async()=>{await $('#save').onclick();await window.motor.start();refresh()};
$('#stop').onclick=async()=>{await window.motor.stop();refresh()};
window.motor.onLog(()=>refresh());
window.motor.onCurrent(v=>$('#current').textContent=v);
refresh();setInterval(refresh,2000);
