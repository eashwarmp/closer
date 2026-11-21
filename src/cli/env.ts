// Load API keys from a local, gitignored .env so they never need to be typed on the command line.
import fs from "node:fs";

if (fs.existsSync(".env")) process.loadEnvFile(".env");
