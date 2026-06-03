const express = require("express");
const cors = require("cors");
const axios = require("axios");
const https = require("https");

const app = express();
app.use(cors());
app.use(express.json());

const inseeAxios = axios.create({
  httpsAgent: new https.Agent({ rejectUnauthorized: false }),
  headers: { Accept: "application/json", "User-Agent": "Mozilla/5.0" },
  timeout: 20000,
});

const defaultAxios = axios.create({
  headers: { "User-Agent": "Mozilla/5.0" },
  timeout: 20000,
});

app.get("/", (req, res) => res.json({ status: "ok", app: "Agenda21 Longévité Backend" }));

// ─── ROUTE ANALYSE ─────────────────────────────────────────────────────────────
app.post("/api/analyse", async (req, res) => {
  try {
    const { prompt } = req.body;
    if (!prompt) return res.status(400).json({ error: "Prompt manquant" });
    const response = await defaultAxios.post("https://api.anthropic.com/v1/messages", {
      model: "claude-sonnet-4-5",
      max_tokens: 1000,
      messages: [{ role: "user", content: prompt }],
    }, {
      headers: {
        "Content-Type": "application/json",
        "x-api-key": process.env.ANTHROPIC_API_KEY,
        "anthropic-version": "2023-06-01",
      },
    });
    const text = (response.data.content || []).map((b) => b.text || "").join("\n");
    res.json({ text });
  } catch (err) {
    res.status(500).json({ error: err.response?.data?.error?.message || err.message });
  }
});

// ─── ROUTE ENRICHIR ────────────────────────────────────────────────────────────
app.post("/api/enrichir", async (req, res) => {
  try {
    const { citycode, city, lat, lon } = req.body;
    const results = {};

    function set(id, val, source, niveau) {
      if (val !== null && val !== undefined && !isNaN(parseFloat(val))) {
        results[id] = { valeur: String(Math.round(parseFloat(val) * 10) / 10), source, niveau };
      }
    }

    // Helper: extraire une valeur d'une série Melodi
    function getMelodiVal(series, keyFragment) {
      if (!series) return null;
      const entry = Object.entries(series).find(([k]) => k.includes(keyFragment));
      if (!entry) return null;
      const obs = Object.values(entry[1].observations || {});
      return obs[0]?.[0] ?? null;
    }

    // 1. API Geo
    try {
      const r = await defaultAxios.get("https://geo.api.gouv.fr/communes/" + citycode + "?fields=nom,population,codeDepartement,codeRegion,epci");
      const d = r.data;
      if (d.population) {
        results["_meta_population"] = { valeur: String(d.population), source: "API Geo gouv.fr", niveau: "commune" };
        results["_meta_seniors"] = { valeur: "Pop. " + d.population + " hab. (75+ estimés ~" + Math.round(d.population * 0.085) + ")", source: "API Geo + benchmark INSEE 2023", niveau: "commune" };
      }
      if (d.epci) results["_meta_epci"] = { valeur: typeof d.epci === "object" ? (d.epci.nom || d.epci.code) : String(d.epci), source: "API Geo gouv.fr", niveau: "epci" };
      if (d.codeDepartement) results["_meta_dept"] = { valeur: "Dép. " + d.codeDepartement, source: "API Geo gouv.fr", niveau: "departement" };
    } catch (e) { console.log("Geo error:", e.message); }

    // 2. Georisques
    try {
      if (lat && lon) {
        const r = await defaultAxios.get("https://georisques.gouv.fr/api/v1/gaspar/risques?rayon=1000&latlon=" + lon + "," + lat + "&page=1&page_size=20");
        console.log("Georisques:", r.status);
        const d = r.data;
        if (d && d.data && d.data.length > 0) {
          const risques = d.data.map((x) => x.libelle_risque_jo || x.code_risque).filter(Boolean);
          results["_meta_georisques"] = { valeur: "Risques : " + risques.slice(0, 5).join(", "), source: "Georisques 2026", niveau: "adresse" };
          if (risques.some((x) => x.toLowerCase().includes("inond"))) set("te5", 45, "Georisques 2026", "adresse");
        } else {
          results["_meta_georisques"] = { valeur: "Aucun risque majeur identifié (rayon 1km)", source: "Georisques 2026", niveau: "adresse" };
        }
      }
    } catch (e) { console.log("Georisques error:", e.message); }

    // 3. ADEME DPE — recherche par nom de ville
    try {
      const cityEncoded = encodeURIComponent(city || "");
      const r = await defaultAxios.get("https://data.ademe.fr/data-fair/api/v1/datasets/dpe03existant/lines?size=500&select=etiquette_dpe&q=" + cityEncoded);
      console.log("ADEME DPE:", r.status, "résultats:", r.data?.results?.length);
      const d = r.data;
      if (d.results && d.results.length > 0) {
        let total = d.results.length, efg = 0, renove = 0;
        d.results.forEach((x) => {
          if (["E", "F", "G"].includes(x.etiquette_dpe)) efg++;
          if (["A", "B", "C"].includes(x.etiquette_dpe)) renove++;
        });
        set("te1", efg / total * 100, "ADEME DPE 2025", "commune");
        set("te2", renove / total * 100, "ADEME DPE 2025", "commune");
        results["_meta_dpe"] = { valeur: total + " DPE : " + Math.round(efg / total * 100) + "% EFG, " + Math.round(renove / total * 100) + "% ABC", source: "ADEME DPE 2025", niveau: "commune" };
      }
    } catch (e) { console.log("ADEME error:", e.response?.status, e.message); }

    // 4. INSEE RP — population par âge (DS_RP_POPULATION_PRINC)
    try {
      const r = await inseeAxios.get("https://api.insee.fr/melodi/data/DS_RP_POPULATION_PRINC?GEO=COM-" + citycode + "&TIME_PERIOD=2021&maxResult=500");
      console.log("INSEE RP Melodi:", r.status);
      const series = r.data?.dataSets?.[0]?.series;
      if (series) {
        let total = 0, s60 = 0, s75 = 0, s85 = 0;
        Object.entries(series).forEach(([key, val]) => {
          const obs = Object.values(val.observations || {});
          const v = parseFloat(obs[0]?.[0] || 0);
          if (isNaN(v)) return;
          total += v;
          // Les codes AGE dans DS_RP_POPULATION_PRINC : Y_GE60, Y_GE75, Y_GE85 ou tranches
          if (key.match(/Y60|Y61|Y62|Y63|Y64|Y65|Y66|Y67|Y68|Y69|Y70|Y71|Y72|Y73|Y74|Y_GE60/)) s60 += v;
          if (key.match(/Y75|Y76|Y77|Y78|Y79|Y80|Y81|Y82|Y83|Y84|Y_GE75/)) { s60 += v; s75 += v; }
          if (key.match(/Y85|Y86|Y87|Y88|Y89|Y90|Y91|Y92|Y93|Y94|Y95|Y96|Y97|Y98|Y99|Y_GE85/)) { s60 += v; s75 += v; s85 += v; }
        });
        if (total > 0) {
          set("v1", s60 / total * 100, "INSEE RP 2021", "commune");
          set("v2", s75 / total * 100, "INSEE RP 2021", "commune");
          set("v3", s85 / total * 100, "INSEE RP 2021", "commune");
          results["_meta_rp"] = { valeur: "Pop. totale RP : " + Math.round(total) + " hab.", source: "INSEE RP 2021", niveau: "commune" };
        }
      }
    } catch (e) { console.log("INSEE RP error:", e.response?.status, e.message); }

    // 5. BPE — services médicaux et sociaux (DS_BPE_SANTE)
    try {
      const r = await inseeAxios.get("https://api.insee.fr/melodi/data/DS_BPE_SANTE?GEO=COM-" + citycode + "&TIME_PERIOD=2023&maxResult=200");
      console.log("BPE Santé:", r.status);
      const series = r.data?.dataSets?.[0]?.series;
      if (series) {
        let medecins = 0, pharmacies = 0, ehpad = 0;
        Object.entries(series).forEach(([key, val]) => {
          const obs = Object.values(val.observations || {});
          const v = parseFloat(obs[0]?.[0] || 0);
          if (isNaN(v)) return;
          if (key.includes("D201")) medecins += v;
          if (key.includes("D401")) pharmacies += v;
          if (key.includes("D109") || key.includes("D110")) ehpad += v;
        });
        const partenaires = (medecins > 0 ? 1 : 0) + (ehpad > 0 ? 2 : 0) + (pharmacies > 0 ? 1 : 0);
        if (partenaires > 0) set("pt1", partenaires, "INSEE BPE 2023", "commune");
        if (medecins > 0 || pharmacies > 0 || ehpad > 0) {
          results["_meta_bpe"] = { valeur: Math.round(medecins) + " médecins, " + Math.round(pharmacies) + " pharmacies, " + Math.round(ehpad) + " EHPAD", source: "INSEE BPE 2023", niveau: "commune" };
        }
      }
    } catch (e) { console.log("BPE error:", e.response?.status, e.message); }

    // 6. Filosofi — pauvreté et revenus (DS_FILOSOFI_COM)
    try {
      const r = await inseeAxios.get("https://api.insee.fr/melodi/data/DS_FILOSOFI_COM?GEO=COM-" + citycode + "&TIME_PERIOD=2020&maxResult=100");
      console.log("Filosofi:", r.status);
      const series = r.data?.dataSets?.[0]?.series;
      if (series) {
        Object.entries(series).forEach(([key, val]) => {
          const obs = Object.values(val.observations || {});
          const v = parseFloat(obs[0]?.[0]);
          if (isNaN(v) || v <= 0) return;
          if (key.includes("TP60") || key.includes("TPOVR")) {
            set("v14", v / 100 * 0.35, "INSEE Filosofi 2020", "commune");
            results["_meta_pauvrete"] = { valeur: "Taux pauvreté : " + v + "%", source: "INSEE Filosofi 2020", niveau: "commune" };
          }
          if ((key.includes("MED") || key.includes("Q2")) && v > 1000) {
            results["_meta_revenu"] = { valeur: Math.round(v) + " €/an (revenu médian)", source: "INSEE Filosofi 2020", niveau: "commune" };
          }
        });
      }
    } catch (e) { console.log("Filosofi error:", e.response?.status, e.message); }

    console.log("Résultats finaux:", Object.keys(results));
    res.json(results);
  } catch (err) {
    console.log("Erreur globale:", err.message);
    res.status(500).json({ error: err.message });
  }
});

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => console.log(`Agenda21 Backend démarré sur le port ${PORT}`));
