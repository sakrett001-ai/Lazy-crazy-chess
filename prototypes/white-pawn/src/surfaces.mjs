// Материалы кузницы поверхностей (prototypes/forge): карта несёт износ —
// царапины, сколы, грязь, шероховатость, — а цвет и блеск задаёт фракция.
// В GLB у таких материалов есть средние значения карты (forgeMeanColor,
// forgeMeanRoughness). Делим на них, чтобы в среднем поверхность получила
// ровно заказанный цвет и шероховатость, а рисунок износа остался.
export function paintSurface(material,color,metalness,roughness){
 const mean=material.userData?.forgeMeanColor,meanRough=material.userData?.forgeMeanRoughness;
 if(color!==null&&color!==undefined){
  Array.isArray(color)?material.color.setRGB(...color):material.color.set(color);
  if(mean&&material.map){material.color.r/=Math.max(mean[0],.05);material.color.g/=Math.max(mean[1],.05);material.color.b/=Math.max(mean[2],.05);}
 }
 material.metalness=metalness;
 material.roughness=meanRough&&material.roughnessMap?roughness/Math.max(meanRough,.05):roughness;
}
