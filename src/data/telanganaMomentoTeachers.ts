import type { MomentoTeacher } from "./karnatakaMomentoTeachers";

const phone10 = (value: unknown) => String(value ?? "").replace(/\D/g, "").slice(-10);

const RAW: Array<{ name: string; phone?: string }> = [
  { name: "Saundarya madam", phone: "8501001100" },
  { name: "Sunke Swapna", phone: "9866937936" },
  { name: "Nagaraju", phone: "9195022618" },
  { name: "Sai Krishna", phone: "7386052669" },
  { name: "Vijay kumar", phone: "9866412418" },
  { name: "nagaraju", phone: "9494257603" },
  { name: "Nagaraj", phone: "9185010011" },
  { name: "Nagaraju", phone: "9502261849" },
  { name: "sai krishna", phone: "9173860526" },
  { name: "Siripuram mohan", phone: "9989729513" },
  { name: "Anil Kumar Sir", phone: "9492788134" },
  { name: "Mahesh Reddy", phone: "9196661178" },
  { name: "Swapan", phone: "9198669379" },
  { name: "Mohan", phone: "9199897295" },
  { name: "Vijay kumar", phone: "1234567890" },
  { name: "Gowtham", phone: "9493134434" },
  { name: "Mahesh sir", phone: "9666117898" },
  { name: "Ravali medam", phone: "9849528997" },
  { name: "Palle Harish", phone: "9949596347" },
  { name: "Thota prasad", phone: "9963716599" },
  { name: "Gunji purnachandra Rao", phone: "9948760516" },
  { name: "Gunji  Mamatha", phone: "8494868322" },
  { name: "Gowthami madam", phone: "8575758550" },
  { name: "Ravali madam", phone: "5862974532" },
  { name: "Sabeer sir", phone: "9198481817" },
  { name: "Anil Kumar", phone: "9492646462" },
  { name: "illendula nagarjuna", phone: "9194942576" },
  { name: "Thulasi Gopal", phone: "9194949898" },
  { name: "Soundarya", phone: "8639390442" },
  { name: "Harish sir", phone: "0" },
  { name: "Rajesh", phone: "9398542086" },
  { name: "Raju", phone: "8247007455" },
  { name: "Sapna", phone: "9866937939" },
  { name: "Raju sir", phone: "9182470074" },
  { name: "ILLENDULA NAGARJUNA", phone: "9494527603" },
  { name: "Srinivas nagula", phone: "8106405912" },
];

export const TELANGANA_MOMENTO_TEACHERS: MomentoTeacher[] = RAW.map((row) => {
  const phone = phone10(row.phone);
  return {
    name: row.name.replace(/\s+/g, " ").trim(),
    phone: phone.length === 10 ? phone : "",
    region: "Telangana",
  };
});
