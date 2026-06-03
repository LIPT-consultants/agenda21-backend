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

// ─── ROUTE DEBUG — teste toutes les APIs et retourne les résultats ─────────────
app.get("/api/debug/:citycode", async (req, res) => {
  const citycode = req.params.citycode;
  const report = {};

  // ADEME — on teste plusieurs variantes d'URL
  const ademeUrls = [
    "https://data.ademe.fr/data-fair/api/v1/datasets/dpe03existant/lines?size=3&select=etiquette_dpe",
    "https://data.ademe.fr/data-fair/api/v1/datasets/dpe-v2-logements-existants/lines?size=3&select=etiquette_dpe",
    "https://data.ademe.fr/data-fair/api/v1/datasets/dpe03existant/lines?size=3&select=etiquette_dpe&qs=code_commune_insee%3A" + citycode,
  ];
  for (const url of ademeUrls) {
    try {
      const r = await defaultAxios.get(url);
      report["ademe_" + ademeUrls.indexOf(url)] = { status: r.status, total: r.data?.total, firstResult: r.data?.results?.[0] };
    } catch (e) {
      report["ademe_" + ademeUrls.indexOf(url)] = { error: e.response?.status + " " + JSON.stringify(e.response?.data).slice(0, 200) };
    }
  }

  // RPLS — plusieurs variantes
  const rplsUrls = [
    "https://tabular-api.data.gouv.fr/api/resources/7649e51e-9418-4173-9dc6-cefb94bbd7c0/data/?page_size=1&commune_code__exact=" + citycode,
    "https://tabular-api.data.gouv.fr/api/resources/7649e51e-9418-4173-9dc6-cefb94bbd7c0/data/?page_size=1",
  ];
  for (const url of rplsUrls) {
    try {
      const r = await defaultAxios.get(url);
      report["rpls_" + rplsUrls.indexOf(url)] = { status: r.status, meta: r.data?.meta, firstRow: r.data?.data?.[0] };
    } catch (e) {
      report["rpls_" + rplsUrls.indexOf(url)] = { error: e.response?.status + " " + JSON.stringify(e.response?.data).slice(0, 200) };
    }
  }

  // INSEE BPE
  try {
    const r = await inseeAxios.get("https://data.insee.fr/api/donnees-locales/V0.1/donnees/geo-TYPEQU@BPE2021/COM-" + citycode + ".all");
    report["bpe"] = { status: r.status, hasCellule: !!r.data?.Cellule, count: r.data?.Cellule?.length };
  } catch (e) {
    report["bpe"] = { error: e.response?.status + " " + e.message + " " + JSON.stringify(e.response?.data).slice(0, 200) };
  }

  // INSEE Filosofi
  try {
    const r = await inseeAxios.get("https://data.insee.fr/api/donnees-locales/V0.1/donnees/geo-INDIC@FILOSOFI2020/COM-" + citycode + ".all");
    report["filosofi"] = { status: r.status, hasCellule: !!r.data?.Cellule };
  } catch (e) {
    report["filosofi"] = { error: e.response?.status + " " + e.message + " " + JSON.stringify(e.response?.data).slice(0, 200) };
  }

  // INSEE RP
  try {
    const r = await inseeAxios.get("https://data.insee.fr/api/donnees-locales/V0.1/donnees/geo-SEXE-AGE15_15_90@GEO2023RP2020/COM-" + citycode + ".all.all");
    report["rp"] = { status: r.status, hasCellule: !!r.data?.Cellule };
  } catch (e) {
    report["rp"] = { error: e.response?.status + " " + e.message + " " + JSON.stringify(e.response?.data).slice(0, 200) };
  }

  res.json(report);
});

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

    // 3. ADEME DPE
    try {
      const r = await defaultAxios.get("https://data.ademe.fr/data-fair/api/v1/datasets/dpe03existant/lines?size=500&select=etiquette_dpe&qs=code_commune_insee%3A" + citycode);
      console.log("ADEME DPE:", r.status);
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

    // 4. RPLS
    try {
      const r = await defaultAxios.get("https://tabular-api.data.gouv.fr/api/resources/7649e51e-9418-4173-9dc6-cefb94bbd7c0/data/?page_size=1&commune_code__exact=" + citycode);
      console.log("RPLS:", r.status);
      const d = r.data;
      if (d && d.meta && d.meta.total > 0) {
        results["_meta_rpls"] = { valeur: d.meta.total + " logements sociaux", source: "RPLS 2023 — data.gouv.fr", niveau: "commune" };
      }
    } catch (e) { console.log("RPLS error:", e.response?.status, e.message); }

    // 5. BPE INSEE
    try {
      const r = await inseeAxios.get("https://data.insee.fr/api/donnees-locales/V0.1/donnees/geo-TYPEQU@BPE2021/COM-" + citycode + ".all");
      console.log("BPE INSEE:", r.status);
      const d = r.data;
      if (d && d.Cellule) {
        let medecins = 0, pharmacies = 0, ehpad = 0, services = 0;
        d.Cellule.forEach((c) => {
          const type = (c.Modalite || []).find((m) => m["@variable"] === "TYPEQU");
          const v = parseFloat(c.Valeur || 0);
          if (!type) return;
          const code = type["@code"];
          if (code === "D201") medecins += v;
          if (code === "D401") pharmacies += v;
          if (["D109", "D110"].includes(code)) ehpad += v;
          if (code === "D107") services += v;
        });
        const partenaires = (medecins > 0 ? 1 : 0) + (ehpad > 0 ? 2 : 0) + (services > 0 ? 2 : 0) + (pharmacies > 0 ? 1 : 0);
        if (partenaires > 0) set("pt1", partenaires, "INSEE BPE 2021", "commune");
        results["_meta_bpe"] = { valeur: Math.round(medecins) + " médecins, " + Math.round(pharmacies) + " pharmacies, " + Math.round(ehpad) + " EHPAD", source: "INSEE BPE 2021", niveau: "commune" };
      }
    } catch (e) { console.log("BPE error:", e.response?.status, e.message); }

    // 6. Filosofi
    try {
      const r = await inseeAxios.get("https://data.insee.fr/api/donnees-locales/V0.1/donnees/geo-INDIC@FILOSOFI2020/COM-" + citycode + ".all");
      console.log("Filosofi:", r.status);
      const d = r.data;
      if (d && d.Cellule) {
        d.Cellule.forEach((c) => {
          const indic = (c.Modalite || []).find((m) => m["@variable"] === "INDIC");
          if (!indic) return;
          const val = parseFloat(c.Valeur);
          if (indic["@code"] === "TP60" && !isNaN(val) && val > 0) {
            set("v14", val / 100 * 0.35, "INSEE Filosofi 2020", "commune");
            results["_meta_pauvrete"] = { valeur: "Taux pauvreté : " + val + "%", source: "INSEE Filosofi 2020", niveau: "commune" };
          }
          if (indic["@code"] === "MED21" && !isNaN(val) && val > 0) {
            results["_meta_revenu"] = { valeur: Math.round(val) + " €/an (revenu médian)", source: "INSEE Filosofi 2020", niveau: "commune" };
          }
        });
      }
    } catch (e) { console.log("Filosofi error:", e.response?.status, e.message); }

    // 7. INSEE RP
    try {
      const r = await inseeAxios.get("https://data.insee.fr/api/donnees-locales/V0.1/donnees/geo-SEXE-AGE15_15_90@GEO2023RP2020/COM-" + citycode + ".all.all");
      console.log("INSEE RP:", r.status);
      const d = r.data;
      if (d && d.Cellule) {
        let total = 0, s60 = 0, s75 = 0, s85 = 0;
        d.Cellule.forEach((c) => {
          const age = (c.Modalite || []).find((m) => m["@variable"] === "AGE15_15_90");
          const v = parseFloat(c.Valeur || 0);
          if (!age) return;
          total += v;
          if (["60-74", "75-89", "90+"].includes(age["@code"])) s60 += v;
          if (["75-89", "90+"].includes(age["@code"])) s75 += v;
          if (age["@code"] === "90+") s85 += v;
        });
        if (total > 0) {
          set("v1", s60 / total * 100, "INSEE RP 2020", "commune");
          set("v2", s75 / total * 100, "INSEE RP 2020", "commune");
          set("v3", s85 / total * 100, "INSEE RP 2020", "commune");
        }
      }
    } catch (e) { console.log("INSEE RP error:", e.response?.status, e.message); }

    console.log("Résultats finaux:", Object.keys(results));
    res.json(results);
  } catch (err) {
    console.log("Erreur globale:", err.message);
    res.status(500).json({ error: err.message });
  }
});

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => console.log(`Agenda21 Backend démarré sur le port ${PORT}`));
