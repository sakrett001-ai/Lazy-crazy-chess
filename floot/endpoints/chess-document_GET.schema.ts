import {z} from 'zod';
export const schema=z.object({});
export type OutputType={html:string; version:string; modelVersion:string; sourceCommit:string; builtAt:string};
export async function getChessDocument(signal?:AbortSignal):Promise<OutputType> {
  const response=await fetch('/_api/chess-document',{signal,cache:'no-store'});
  if(!response.ok){const body=await response.json().catch(()=>({}));throw new Error(body.error||'Не удалось загрузить просмотрщик. Повторите попытку.');}
  return response.json();
}
