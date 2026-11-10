# Lazy-crazy-chess

Живые шахматы: классические правила, фигуры переходят из партии в партию, взятие показано как проигранная дуэль.
Подробности — `README.md` и `README.md` в каждой папке `prototypes/`.

## Подготовка

Node.js 24 (как в CI). Зависимости ставятся в два прототипа, доска берёт их оттуда:

```
npm ci --prefix prototypes/human-base
npm ci --prefix prototypes/white-pawn
npm ci --prefix prototypes/board
```

## Проверка

Без браузера:

- Доска, правила и движения: `cd prototypes/board && npm test`
- Сборка доски и лаборатории движений: `cd prototypes/board && npm run build`
- Пешка, экипировка и биомеханика: `cd prototypes/white-pawn && npm run verify:equipment && npm run verify:biomechanics && npm run verify:grip && npm run verify:weapon-clearance && npm run verify:enarmes && npm run verify:body-contact && npm run verify:facial-hair`

С браузером (сначала `cd prototypes/human-base && npx playwright install chromium`; путь к Chrome можно задать в `CHROME_PATH`):

- Плавность и связки: `cd prototypes/board && npm run verify:smooth && npm run verify:duel && npm run verify:capture && npm run verify:strikes`
- Пешка: `cd prototypes/white-pawn && npm run build && npm run verify && npm run test:release`
