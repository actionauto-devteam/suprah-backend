import express, { Application, Request, Response } from "express";
import mongoose from "mongoose";
import dotenv from "dotenv";

// Load .env variables
dotenv.config();

const app: Application = express();

// Middleware
app.use(express.json());

// Environment variables
const PORT = process.env.PORT || 5000;
const MONGODB_URI = process.env.MONGODB_URI;

// Simple test route
app.get("/", (req: Request, res: Response) => {
  res.send("Server is running!");
});

// Connect to MongoDB and start server
mongoose
  .connect(MONGODB_URI || "")
  .then(() => {
    console.log("Connected to MongoDB");
    app.listen(PORT, () => {
      console.log(`Server running on port ${PORT}`);
    });
  })
  .catch((err) => {
    console.error("Failed to connect to MongoDB", err);
    process.exit(1);
  });
