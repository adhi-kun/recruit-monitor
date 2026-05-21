export const config = {
  port: process.env.PORT || 4000,
  jwtSecret: process.env.JWT_SECRET,
  clientOrigin: process.env.CLIENT_ORIGIN || 'http://localhost:5173',
  clientOriginProd: process.env.CLIENT_ORIGIN_PROD,
  deepgramApiKey: process.env.DEEPGRAM_API_KEY,
};
