import { ANDHRA_PRADESH_MOMENTO_TEACHERS } from "./andhraPradeshMomentoTeachers";
import { KARNATAKA_MOMENTO_TEACHERS } from "./karnatakaMomentoTeachers";
import { KARNATAKA_ONE_MOMENTO_TEACHERS } from "./karnatakaOneMomentoTeachers";
import { TAMIL_NADU_MOMENTO_TEACHERS } from "./tamilNaduMomentoTeachers";
import { TELANGANA_MOMENTO_TEACHERS } from "./telanganaMomentoTeachers";
import { MAHARASHTRA_MOMENTO_TEACHERS } from "./maharashtraMomentoTeachers";
import { ODISHA_MOMENTO_TEACHERS } from "./odishaMomentoTeachers";
import { RAJASTHAN_MOMENTO_TEACHERS } from "./rajasthanMomentoTeachers";
import { UTTAR_PRADESH_MOMENTO_TEACHERS } from "./uttarPradeshMomentoTeachers";

export type { MomentoRegion, MomentoTeacher } from "./karnatakaMomentoTeachers";

export const MOMENTO_TEACHERS = [
  ...KARNATAKA_ONE_MOMENTO_TEACHERS,
  ...KARNATAKA_MOMENTO_TEACHERS,
  ...TELANGANA_MOMENTO_TEACHERS,
  ...ANDHRA_PRADESH_MOMENTO_TEACHERS,
  ...TAMIL_NADU_MOMENTO_TEACHERS,
  ...UTTAR_PRADESH_MOMENTO_TEACHERS,
  ...RAJASTHAN_MOMENTO_TEACHERS,
  ...ODISHA_MOMENTO_TEACHERS,
  ...MAHARASHTRA_MOMENTO_TEACHERS,
];
