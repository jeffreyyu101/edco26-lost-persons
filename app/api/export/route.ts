import { currentStaff, db, jsonError } from '@/lib/server';
export async function GET(){
 if(!(await currentStaff()))return jsonError('Session expired.',401);
 const {data,error}=await db().from('patients').select('*').order('created_at',{ascending:false});
 if(error)return jsonError('Export failed.',503);
 const cols=Object.keys(data?.[0]||{id:'',case_number:'',status:'',created_at:''});
 const cell=(v:unknown)=>{let s=String(v??'');if(/^[=+@\-\t\r]/.test(s))s="'"+s;return '"'+s.replaceAll('"','""')+'"'};
 const csv=[cols.map(cell).join(','),...(data||[]).map(r=>cols.map(k=>cell((r as Record<string,unknown>)[k])).join(','))].join('\r\n');
 return new Response(csv,{headers:{'Content-Type':'text/csv; charset=utf-8','Content-Disposition':'attachment; filename="edc-lost-person-export.csv"','Cache-Control':'no-store'}});
}
