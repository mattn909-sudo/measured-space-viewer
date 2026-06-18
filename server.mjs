import path from "node:path";
import { fileURLToPath } from "node:url";

import express from "express";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT || 4177);
const PUBLIC_DIR = path.join(__dirname, "public");

const app = express();
app.use(express.static(PUBLIC_DIR));

app.listen(PORT, () => {
  console.log(`Measured Space viewer app: http://127.0.0.1:${PORT}`);
});
