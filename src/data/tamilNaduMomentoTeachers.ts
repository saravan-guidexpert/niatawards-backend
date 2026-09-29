import type { MomentoTeacher } from "./karnatakaMomentoTeachers";

const phone10 = (value: unknown) => String(value ?? "").replace(/\D/g, "").slice(-10);

const RAW: Array<{ name: string; phone?: string }> = [
  { name: "Mercy anita", phone: "9585831056" },
  { name: "Noorul shifa", phone: "7867906968" },
  { name: "Priyadarshini", phone: "9181481476" },
  { name: "Meena karupaiah", phone: "9789514163" },
  { name: "Nadana vasuki", phone: "9952504584" },
  { name: "Suresh", phone: "9198419298" },
  { name: "Saranya", phone: "9191599910" },
  { name: "R. NAGAJOTHI", phone: "7708411944" },
  { name: "Priyadarshini", phone: "8148147660" },
  { name: "Krishna Kumar C", phone: "9976647985" },
  { name: "Preeti", phone: "9195390337" },
  { name: "Meenakshi", phone: "9163808206" },
  { name: "S Sasikumar", phone: "9176346961" },
  { name: "SRIVIDYA SATISH", phone: "9923385788" },
  { name: "SAIPRIYA", phone: "9199622265" },
  { name: "Shanmugapriya. S", phone: "9190803729" },
  { name: "Hema Iyer", phone: "9047706725" },
  { name: "Suryanarayana k", phone: "9788491420" },
  { name: "R NIVEKHA", phone: "8344257919" },
  { name: "N.kishan", phone: "9384057299" },
  { name: "Mary ramila", phone: "8973555581" },
  { name: "Kavitha", phone: "9597326626" },
  { name: "M.SELVI", phone: "8189885688" },
  { name: "Jaya bharathi", phone: "6383152028" },
  { name: "A.K.AaminaBibi", phone: "9361211276" },
  { name: "Dhulasi mani B", phone: "7867066865" },
  { name: "A. Sameena", phone: "6383764429" },
  { name: "RANJITH PRABU", phone: "9500578901" },
  { name: "SALINI D", phone: "8807180678" },
  { name: "K.Anishbarveen", phone: "8838167199" },
  { name: "D.PRABHAKARSN", phone: "9841144658" },
  { name: "G. Kartheeswari", phone: "6383257636" },
  { name: "நித்தியானந்தம்", phone: "8110012281" },
  { name: "Chitradevi", phone: "9659250360" },
  { name: "நித்தியானந்தம்", phone: "8248218084" },
  { name: "M. NANDHINI", phone: "9361591632" },
  { name: "Dr.R.KARTHICK PILLAI", phone: "9789938123" },
  { name: "Preeta Lakshmi", phone: "9961418042" },
  { name: "Aarti Mehta", phone: "9962287903" },
  { name: "JAMES A L", phone: "9715054634" },
  { name: "Deepika Karthikeyan", phone: "9196863443" },
  { name: "Kumar sir", phone: "9840221406" },
  { name: "Meena Vishwanathan", phone: "8220741157" },
  { name: "Rajat arora", phone: "9927046305" },
];

export const TAMIL_NADU_MOMENTO_TEACHERS: MomentoTeacher[] = RAW.map((row) => {
  const phone = phone10(row.phone);
  return {
    name: row.name.replace(/\s+/g, " ").trim(),
    phone: phone.length === 10 ? phone : "",
    region: "Tamil Nadu",
  };
});
