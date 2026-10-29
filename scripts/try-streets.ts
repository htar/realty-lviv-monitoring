// Quick manual check: prints which streets/localities are recognised in sample texts.
import { defaultStreetIndex } from "../src/streets.js";

const index = defaultStreetIndex()!;
const samples = process.argv.slice(2).length ? process.argv.slice(2) : [
  "Здам 1к квартиру на вул. Замарстинівській, 15000 грн",
  "Оренда 2к, Наукова вулиця, новобуд",
  "Квартира на Голоску, біля парку",
  "вул. Тараса Шевченка 45",
  "просп. Шевченка, центр",
  "Сдам квартиру, ул. Городоцкая",
  "вул. Хмельницького 120, Підзамче",
  "Оренда на Сихові, вул. Зелена",
  "квартира біля Опери, вул. Дорошенка",
  "Здам квартиру, гарний ремонт"
];
for (const text of samples) {
  const found = index.find(text);
  console.log(`${text}\n   → ${found.map((m) => `${m.label} [${m.districts.join(", ")}]`).join("; ") || "нічого"}`);
}
