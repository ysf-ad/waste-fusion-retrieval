// One shared image, parallel atomic questions. Branch only in code: no serial RTTs.
export const choice = (instructions, criteria) => ({ type: 'choice', instructions, criteria });
export const QUESTIONS = {
  kind: choice('Identify the single dominant item in photo. Choose unknown for competing items or an unclear view; do not guess material or contents.', {
    plastic_drink_bottle: 'Plastic beverage/water bottle', metal_food_drink_can: 'Metal food or beverage can, not pressurized aerosol',
    glass_food_drink_container: 'Intact glass food jar or beverage bottle, not cookware, bulb or chemical container',
    paper_sheet: 'Plain paper, newspaper or magazine', cardboard_box: 'Cardboard box or corrugated cardboard',
    paper_cup: 'Paper takeaway coffee/beverage cup', foam_food_container: 'Styrofoam food cup, plate or takeout container',
    rigid_plastic_food_container: 'Rigid plastic food tub, tray, cup or clamshell', plastic_film_bag: 'Plastic film or bag',
    snack_wrapper: 'Chip bag, candy wrapper or multilayer snack pouch', food_scraps: 'Food scraps, peel, eggshell, coffee grounds or tea bag',
    battery: 'Battery or power bank', electronics: 'Electronic device, charger, cable or electronic part',
    hazardous_product: 'Paint, chemical, medicine, spray/aerosol can or hazardous product container',
    sharp: 'Needle, razor, sharp blade or broken glass', textile: 'Clothing, shoe or fabric',
    ceramic: 'Ceramic/porcelain object', other: 'A clear object outside these supported types', unknown: 'Unclear image, no waste object, or multiple competing items',
  }),
  hazard: choice('Does photo show a household special-handling hazard? Ordinary food/drink packaging, including a carbonated soda can, is not hazardous merely because it is a metal can or has a closed lid. Choose unknown only when object identity is genuinely unclear.', {
    evident: 'Battery, electronics, chemical/medicine, aerosol SPRAY can with spray nozzle, needle/blade or broken glass (not an ordinary food/drink can)',
    absent: 'Clearly an ordinary food/beverage/paper item with no sign of these hazards', unknown: 'Cannot rule out a special-handling item from the photo',
  }),
  condition: choice('For the dominant container, can its interior be seen sufficiently to establish that it is empty and free of residue? A label, barcode, exterior cleanliness or closed lid is NOT evidence of an empty interior.', {
    empty_clean: 'Interior is visible and empty, no food/liquid/residue', contents: 'Food, liquid or residue visibly remains',
    not_container: 'Not a container', unknown: 'Interior/contents cannot be verified',
  }),
  plastic_color: choice('If the item is plastic/foam, is the plastic itself black? Ignore black printing on a differently colored package.', {
    black: 'Plastic/foam material is black', non_black: 'Plastic/foam material is visibly not black', not_plastic: 'Not plastic/foam', unknown: 'Cannot determine',
  }),
  compostable_mark: choice('Is the plastic item explicitly labeled compostable or biodegradable? Do not infer certification or resin from appearance.', {
    marked: 'Visible compostable/biodegradable marking', not_marked: 'Readable item/markings do not show this', not_plastic: 'Not plastic', unknown: 'Labels cannot be checked',
  }),
  paper_finish: choice('For paper/cardboard, is it uncoated or waxed/laminated? If uncertain choose unknown.', {
    uncoated: 'Plain unwaxed paper/cardboard', coated: 'Waxed, laminated, plastic-lined or mixed-material paper', not_paper: 'Not paper/cardboard', unknown: 'Cannot determine finish',
  }),
  paper_soiling: choice('For paper/cardboard, is there visible food, grease or liquid contamination?', {
    clean: 'Clearly unsoiled', soiled: 'Visibly food/grease/liquid-soiled', not_paper: 'Not paper/cardboard', unknown: 'Cannot determine',
  }),
};

export function baselineQuestions(items) {
  const questions = {};
  for (let i = 0; i < items.length; i += 240) {
    questions[`items_${i / 240}`] = choice('Which listed item best matches photo?', {
      none: 'Not in this list or uncertain',
      ...Object.fromEntries(items.slice(i, i + 240).map((item, offset) => [`item_${i + offset}`, item.item])),
    });
  }
  return questions;
}
