import {chessRelease} from '../helpers/chessRelease';
export async function handle(_request:Request) {
  const headers={'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store'};
  try {return new Response(JSON.stringify(await chessRelease.read()),{headers});}
  catch(error){console.error('chess-document:',error instanceof Error?error.message:String(error));return new Response(JSON.stringify({error:'Не удалось загрузить проверенную версию просмотрщика. Повторите попытку.'}),{status:503,headers});}
}
