import {useQuery} from '@tanstack/react-query';
import {Helmet} from 'react-helmet';
import {Button} from '../components/Button';
import {getChessDocument} from '../endpoints/chess-document_GET.schema';
import styles from './_index.module.css';

export default function ChessWorkshop() {
  const release=useQuery({queryKey:['chess-release'],queryFn:({signal})=>getChessDocument(signal),staleTime:Infinity,retry:1,refetchOnWindowFocus:false});
  return <main className={styles.shell} data-source-commit={release.data?.sourceCommit} data-release-version={release.data?.version}>
    <Helmet><html lang="ru"/><title>Lazy Crazy Chess · мастерская пешки</title>
      <meta name="description" content="Осмотр белой пешки, проверка движений и замечания к 3D-модели Lazy Crazy Chess."/>
      <meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover"/>
      <meta name="theme-color" content="#f7f5ef"/>
    </Helmet>
    {release.data ? <iframe className={styles.frame} title="Мастерская белой пешки" srcDoc={release.data.html} allow="fullscreen; clipboard-write"/> :
      <section className={styles.status} aria-live="polite">
        <span className={styles.eyebrow}>LAZY CRAZY CHESS / МАСТЕРСКАЯ</span>
        <h1>Белая пешка</h1>
        <p className={styles.subtitle}>Осмотреть. Остановить движение. Отметить деталь.</p>
        <div className={styles.preview} aria-hidden="true">♙</div>
        {release.isError ? <><p role="alert">{release.error instanceof Error ? release.error.message : 'Не удалось загрузить просмотрщик.'}</p><Button onClick={()=>release.refetch()} disabled={release.isFetching}>{release.isFetching?'Загружаем…':'Повторить загрузку'}</Button></> : <p role="status">Загружаем проверенную версию просмотрщика…</p>}
        <p className={styles.hint}>3D-просмотр · анимации · замечания к модели</p>
      </section>}
  </main>;
}
