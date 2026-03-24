import fs from "fs";
import path from "path";
import csv from "csv-parser";
import Database from "better-sqlite3";

// Pointing to the data folder at the root
const csvPath = path.resolve(__dirname, "../data/mna_200_listings.csv");
const dbPath = path.resolve(__dirname, "../data/mna_vault.db");

const db = new Database(dbPath);

db.exec(`
  DROP TABLE IF EXISTS listings;
  CREATE TABLE listings (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    description TEXT,
    annual_revenue REAL,
    ebitda REAL,
    asking_price REAL,
    sde REAL
  )
`);

const insert = db.prepare(`
  INSERT INTO listings (description, annual_revenue, ebitda, asking_price, sde)
  VALUES (@description, @annual_revenue, @ebitda, @asking_price, @sde)
`);

fs.createReadStream(csvPath)
  .pipe(csv())
  .on("data", (row) => {
    insert.run({
      description: row.description || "",
      annual_revenue: parseFloat(row.annual_revenue || 0),
      ebitda: parseFloat(row.ebitda || 0),
      asking_price: parseFloat(row.asking_price || 0),
      sde: parseFloat(row.sde || 0),
    });
  })
  .on("end", () => {
    console.log("✅ Vault built successfully at data/mna_vault.db");
    process.exit(0);
  });
