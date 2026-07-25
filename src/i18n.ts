import i18n from "i18next";
import LanguageDetector from "i18next-browser-languagedetector";
import { initReactI18next } from "react-i18next";
import de from "./locales/de/translation.json";
import en from "./locales/en/translation.json";

void i18n
  .use(LanguageDetector)
  .use(initReactI18next)
  .init({
    fallbackLng: "de",
    debug: import.meta.env.DEV,
    interpolation: { escapeValue: false },
    resources: {
      de: { translation: de },
      en: { translation: en },
    },
  });

export default i18n;
