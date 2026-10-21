import {createHash} from 'node:crypto';

const repository='sakrett001-ai/Lazy-crazy-chess';
const upstream=`https://raw.githubusercontent.com/${repository}/gh-pages/`;
const maxDocumentBytes=2_500_000;
type Release={schemaVersion:1; repository:string; sourceBranch:'main'; sourceCommit:string; version:string; modelVersion:string; checks:'passed'; builtAt:string; document:{path:string; sha256:string; bytes:number}};

function validate(value:unknown):Release {
  const m=value as Release;
  if(!m || m.schemaVersion!==1 || m.repository!==repository || m.sourceBranch!=='main' || m.checks!=='passed' || !/^[a-f0-9]{40}$/.test(m.sourceCommit) || !/^\d+\.\d+\.\d+$/.test(m.version) || !/^\d+\.\d+\.\d+$/.test(m.modelVersion) || typeof m.builtAt!=='string' || !Number.isFinite(Date.parse(m.builtAt))) throw new Error('Не удалось подтвердить версию просмотрщика. Повторите загрузку позже.');
  const d=m.document;
  if(!d || d.path!==`chess/releases/${m.sourceCommit}/viewer.html` || !/^[a-f0-9]{64}$/.test(d.sha256) || !Number.isInteger(d.bytes) || d.bytes<1 || d.bytes>maxDocumentBytes) throw new Error('Описание сборки не прошло проверку.');
  return m;
}

async function download(url:string,limit:number,fetcher:typeof fetch):Promise<Uint8Array> {
  const r=await fetcher(url,{redirect:'error',signal:AbortSignal.timeout(20000),cache:'no-store'});
  if(!r.ok) throw new Error('Сервер версий временно недоступен. Повторите загрузку.');
  if(Number(r.headers.get('content-length')||0)>limit) throw new Error('Сборка превышает допустимый размер.');
  if(!r.body) throw new Error('Сервер вернул пустую сборку.');
  const reader=r.body.getReader(); const chunks:Uint8Array[]=[]; let size=0;
  while(true){const {done,value}=await reader.read();if(done)break;size+=value.byteLength;if(size>limit){await reader.cancel();throw new Error('Сборка превышает допустимый размер.');}chunks.push(value);}
  const bytes=new Uint8Array(size);let offset=0;for(const chunk of chunks){bytes.set(chunk,offset);offset+=chunk.byteLength;}return bytes;
}

async function read(fetcher:typeof fetch=fetch) {
  const manifest=await download(`${upstream}chess-release.json?t=${Math.floor(Date.now()/60000)}`,16384,fetcher);
  const release=validate(JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(manifest)));
  const bytes=await download(upstream+release.document.path,maxDocumentBytes,fetcher);
  if(bytes.byteLength!==release.document.bytes || createHash('sha256').update(bytes).digest('hex')!==release.document.sha256) throw new Error('Сборка не прошла проверку целостности. Повторите загрузку.');
  const html=new TextDecoder('utf-8',{fatal:true}).decode(bytes);
  if(!html.includes('PAWN_HOSTED') || /serviceWorker\s*\.\s*register/.test(html)) throw new Error('Сборка не подходит для просмотра.');
  return {html,version:release.version,modelVersion:release.modelVersion,sourceCommit:release.sourceCommit,builtAt:release.builtAt};
}

export const chessRelease={read};
