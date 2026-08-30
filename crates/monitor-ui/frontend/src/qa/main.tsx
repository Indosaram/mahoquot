import React from "react";
import ReactDOM from "react-dom/client";
import { PrimitiveShowcase } from "./PrimitiveShowcase";
import "../styles/globals.css";

const root = document.getElementById("root");
if (!root) throw new Error("Missing #root element");

ReactDOM.createRoot(root).render(
  <React.StrictMode>
    <PrimitiveShowcase />
  </React.StrictMode>,
);
