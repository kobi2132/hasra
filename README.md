# חסרה על הימין

אתר משפחתי להקלטות הווידאו של משפחת ימין משנות ה־90. הסרטונים נשארים בפלייליסט ביוטיוב, והאתר מוסיף מעליהם רגעים מסומנים, תיוג אנשים ותגובות.

- **אחסון:** GitHub Pages (חינם). אתר סטטי, בלי שלב בנייה.
- **נתונים:** Firebase Firestore + Authentication בשכבה החינמית (Spark), בלי כרטיס אשראי.
- **סרטונים:** YouTube Data API v3 עם מפתח ה־Firebase (מכסה חינמית של 10,000 יחידות ביום; כל טעינה עולה 2 יחידות ונשמרת במטמון 6 שעות).

## קבצים

| קובץ | תפקיד |
|---|---|
| `config.js` | מזהה הפלייליסט והגדרות Firebase. כש־`firebase: null` האתר רץ במצב הדגמה מקומי |
| `app.js` | ממשק: רשימה, עמוד סרטון, נגן, רגעים, תיוגים, תגובות, כניסה |
| `store.js` | שכבת הנתונים (Firebase או הדגמה) |
| `videos.js` | טעינת הפלייליסט מיוטיוב |
| `firestore.rules` | כללי הגישה. להדביק ב־Firebase Console › Firestore › Rules |

## כניסה והרשאות

- צפייה פתוחה לכולם. כדי לסמן רגע, לתייג או להגיב נכנסים עם שם וטלפון (בלי SMS). המכשיר זוכר את המשתמש.
- הטלפון לא נשמר: נשמר רק גיבוב (hash) שלו, שמזהה את המשתמש גם ממכשיר אחר.
- כל אחד עורך ומוחק את מה שהוא כתב.
- **מנהל:** "כניסת מנהל עם גוגל" בתפריט המשתמש. החשבון הראשון שנכנס כך נרשם כמנהל, ואחריו הדלת ננעלת. מנהלים נוספים מוסיפים ידנית במסוף: מסמך `admins/<email>`.
- המנהל עורך שם, תיאור ושנה של סרטון (מעל מה שמגיע מיוטיוב), ומוחק כל דבר.

## הקמה

1. Firebase: פרויקט חדש, Authentication עם Anonymous ו־Google, Firestore ב־production mode.
2. ב־Authentication › Settings › Authorized domains להוסיף את `kobi2132.github.io`.
3. להדביק את `firestore.rules` בלשונית Rules ולפרסם.
4. להפעיל את YouTube Data API v3 בפרויקט ה־Google Cloud של Firebase.
5. להעתיק את `firebaseConfig` אל `config.js`.
6. GitHub › Settings › Pages › Deploy from branch › `main` / root.

## פיתוח מקומי

```
python3 -m http.server 8765
```
ופתיחת http://localhost:8765 (מצב הדגמה כש־`firebase: null`).
