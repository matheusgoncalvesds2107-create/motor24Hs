import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { GoogleGenAI } from '@google/genai';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const outDir = path.join(ROOT, 'radio-assets', 'vinhetas');
const station = JSON.parse(fs.readFileSync(path.join(__dirname,'station-presenter.json'),'utf8'));
const scripts = JSON.parse(fs.readFileSync(path.join(outDir,'roteiros-matheus.json'),'utf8'));
const hourly = JSON.parse(fs.readFileSync(path.join(outDir,'vinhetas-hora-certa-24h.json'),'utf8'));

const apiKey = process.env.GEMINI_API_KEY;
if (!apiKey) {
  console.error('ERRO: defina GEMINI_API_KEY no Windows antes de gerar as vinhetas.');
  process.exit(1);
}

const ai = new GoogleGenAI({ apiKey });

function wavHeader(pcmLength, sampleRate=24000, channels=1, bits=16) {
  const blockAlign = channels * bits / 8;
  const byteRate = sampleRate * blockAlign;
  const b = Buffer.alloc(44);
  b.write('RIFF',0); b.writeUInt32LE(36+pcmLength,4); b.write('WAVE',8);
  b.write('fmt ',12); b.writeUInt32LE(16,16); b.writeUInt16LE(1,20);
  b.writeUInt16LE(channels,22); b.writeUInt32LE(sampleRate,24); b.writeUInt32LE(byteRate,28);
  b.writeUInt16LE(blockAlign,32); b.writeUInt16LE(bits,34);
  b.write('data',36); b.writeUInt32LE(pcmLength,40);
  return b;
}

async function tts(text) {
  const prompt = `Fale em português brasileiro como ${station.presenter}, ${station.style}. Não cante. Diga exatamente esta locução de rádio: ${text}`;
  const r = await ai.models.generateContent({
    model: 'gemini-2.5-flash-preview-tts',
    contents: [{ role: 'user', parts: [{ text: prompt }] }],
    config: {
      responseModalities: ['AUDIO'],
      speechConfig: {
        voiceConfig: {
          prebuiltVoiceConfig: { voiceName: station.geminiVoice || 'Puck' }
        }
      }
    }
  });

  const part = r?.candidates?.[0]?.content?.parts?.find(p => p.inlineData?.data);
  if (!part) throw new Error('Gemini não retornou áudio.');
  const pcm = Buffer.from(part.inlineData.data, 'base64');
  return Buffer.concat([wavHeader(pcm.length), pcm]);
}

for (const [name, text] of Object.entries(scripts)) {
  const file = path.join(outDir, `${name}.wav`);
  if (fs.existsSync(file) && fs.statSync(file).size > 1000) {
    console.log('Já existe, pulando:', name);
    continue;
  }
  console.log('Gerando:', name);
  try {
    fs.writeFileSync(file, await tts(text));
    console.log('OK:', file);
  } catch (e) {
    console.error('FALHOU:', name, '-', e.message);
    console.error('Pare por aqui se aparecer 429 para não gastar a cota.');
    process.exit(2);
  }
}


for (const [hour, text] of Object.entries(hourly)) {
  const file = path.join(outDir, `hora-${hour}.wav`);
  if (fs.existsSync(file) && fs.statSync(file).size > 1000) {
    console.log('Já existe, pulando hora:', hour);
    continue;
  }
  console.log('Gerando hora certa:', hour);
  try {
    fs.writeFileSync(file, await tts(text));
    console.log('OK:', file);
  } catch (e) {
    console.error('FALHOU hora '+hour+':', e.message);
    console.error('Se aparecer 429, pare por hoje. Os arquivos já gerados ficam salvos.');
    process.exit(2);
  }
}

console.log('\nVinhetas do Matheus Gonçalves e hora certa 24H preparadas.');

