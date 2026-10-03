
const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('motor',{
  state:()=>ipcRenderer.invoke('get-state'),
  save:(cfg)=>ipcRenderer.invoke('save-config',cfg),
  chooseSongs:()=>ipcRenderer.invoke('choose-songs'),
  choosePrograms:()=>ipcRenderer.invoke('choose-programs'),
  chooseJingles:()=>ipcRenderer.invoke('choose-jingles'),
  start:()=>ipcRenderer.invoke('start-engine'),
  stop:()=>ipcRenderer.invoke('stop-engine'),
  onLog:(cb)=>ipcRenderer.on('engine-log',(_e,v)=>cb(v)),
  onCurrent:(cb)=>ipcRenderer.on('current-label',(_e,v)=>cb(v))
});
