import type { MomentoTeacher } from "./karnatakaMomentoTeachers";

const phone10 = (value: unknown) => String(value ?? "").replace(/\D/g, "").slice(-10);

const RAW: Array<{ name: string; phone?: string }> = [
  { name: "Sukant Mohaptra" },
  { name: "Puspita Mishra" },
  { name: "Bhagban Padhi" },
  { name: "Sumit Patel" },
  { name: "Rahul Jha" },
  { name: "Karan Sahu" },
  { name: "Chitaranjan Pati" },
  { name: "Manoranjan Mishra" },
  { name: "Pratap Chandra Pradhan" },
  { name: "Aditya Panda" },
  { name: "Shweta Pattnaik" },
  { name: "Ranjan Jha" },
  { name: "Dr. Hrushikesh Acharya" },
  { name: "Manoranjan Palai" },
  { name: "Dr. Manoranjan Pradhan" },
  { name: "Satya Sundar Mohanty" },
  { name: "Sanjay Kumar" },
  { name: "Paresh Kumar Rout" },
  { name: "Biswanath Naik" },
  { name: "Kalicharan Sahu" },
  { name: "Bibhuti Bhusan Behera" },
  { name: "Swadhin Kumar Nayak" },
  { name: "Pabir Pattanayak" },
  { name: "Bhabani Pattanayak" },
  { name: "Sushanta Kumar Parida" },
  { name: "Sanjay Kumar Sahoo" },
  { name: "Sambit Ranjan" },
  { name: "Manamaya Patro" },
  { name: "Prakash Dalai" },
  { name: "Prasant Pattnaik" },
  { name: "Kanhu Charan Panda" },
  { name: "Khyati Swain" },
  { name: "Suman Panigrahi" },
  { name: "Ashish kumar Sahoo" },
  { name: "Jiban Kishore Mishra", phone: "9777012425" },
  { name: "Rajendra Kumar Padhi", phone: "9439011323" },
];

export const ODISHA_MOMENTO_TEACHERS: MomentoTeacher[] = RAW.map((row) => {
  const phone = phone10(row.phone);
  return {
    name: row.name.replace(/\s+/g, " ").trim(),
    phone: phone.length === 10 ? phone : "",
    region: "Odisha",
  };
});
