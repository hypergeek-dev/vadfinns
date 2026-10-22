import { createApp } from './app.js';

const port = Number(process.env.PORT) || 3000;
const { app } = await createApp();
app.listen(port, () => {
  console.log(`Vad finns? körs på http://localhost:${port}`);
  if (process.env.NODE_ENV !== 'production' && !process.env.ADMIN_PASSWORD) {
    console.log('Utvecklingslösenord för Admin: vadfinns-dev');
  }
});
