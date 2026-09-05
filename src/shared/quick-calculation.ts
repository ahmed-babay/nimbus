/** Deliberately narrow: only complete numeric requests bypass the model. No eval. */
const UNITS: Record<string, [dimension: string, scale: number, offset: number, label: string]> = {}
function unit(names: string, dimension: string, scale: number, label: string, offset = 0): void {
  for (const name of names.split('|')) UNITS[name] = [dimension, scale, offset, label]
}
unit('m|meter|meters|metre|metres', 'length', 1, 'm')
unit('km|kilometer|kilometers|kilometre|kilometres', 'length', 1000, 'km')
unit('cm|centimeter|centimeters|centimetre|centimetres', 'length', .01, 'cm')
unit('mm|millimeter|millimeters', 'length', .001, 'mm')
unit('mi|mile|miles', 'length', 1609.344, 'miles')
unit('ft|foot|feet', 'length', .3048, 'ft')
unit('in|inch|inches', 'length', .0254, 'inches')
unit('kg|kilogram|kilograms', 'mass', 1, 'kg')
unit('g|gram|grams', 'mass', .001, 'g')
unit('lb|lbs|pound|pounds', 'mass', .45359237, 'lb')
unit('oz|ounce|ounces', 'mass', .028349523125, 'oz')
unit('s|sec|second|seconds', 'time', 1, 'seconds')
unit('min|minute|minutes', 'time', 60, 'minutes')
unit('h|hr|hour|hours', 'time', 3600, 'hours')
unit('day|days', 'time', 86400, 'days')
unit('c|celsius', 'temperature', 1, '°C')
unit('f|fahrenheit', 'temperature', 5 / 9, '°F', -32 * 5 / 9)
unit('k|kelvin', 'temperature', 1, 'K', -273.15)

const numberText = (value: number): string => Number(value.toPrecision(12)).toLocaleString('en-US', { maximumSignificantDigits: 12 })
export function quickCalculation(input: string): string | null {
  const text = input.toLowerCase().trim().replace(/[?!.]+$/, '').replace(/^please\s+/, '')
  const conversion = text.match(/^(?:convert |what is |whats |what's |how much is )?(-?\d+(?:\.\d+)?)\s*°?\s*([a-z]+)\s+(?:to|in)\s+°?\s*([a-z]+)$/)
  if (conversion) {
    const [, amount, from, to] = conversion
    const a = UNITS[from], b = UNITS[to]
    if (!a || !b || a[0] !== b[0]) return null
    const base = Number(amount) * a[1] + a[2]
    if (a[0] === 'temperature' && base < -273.15000001) return 'That temperature is below absolute zero. Check the value and unit.'
    const value = (base - b[2]) / b[1]
    if (!Number.isFinite(value)) return 'That value is too large to calculate reliably.'
    return `${numberText(Number(amount))} ${a[3]} = ${numberText(value)} ${b[3]}.`
  }
  if (/^\d{4}-\d{1,2}-\d{1,2}$/.test(text)) return null
  const expression = text.replace(/^(calculate|compute|what is|whats|what's|how much is)\s+/, '')
    .replace(/\bmultiplied by\b|\btimes\b|×/g, '*').replace(/\bdivided by\b|÷/g, '/')
    .replace(/\bplus\b/g, '+').replace(/\bminus\b/g, '-').replace(/\bpercent of\b|%\s*of\b/g, '/100*')
    .replace(/\s/g, '')
  if (expression.length > 180 || !/^[\d.+*/()%-]+$/.test(expression) || !/[+*/%()-]/.test(expression)) return null
  const tokens = expression.match(/(?:\d+(?:\.\d*)?|\.\d+)|[+*/()%-]/g) ?? []
  if (tokens.join('') !== expression) return null
  if (tokens.some(token => /^\d/.test(token) && Number(token) > Number.MAX_SAFE_INTEGER)) return 'That number exceeds the precision of the quick calculator.'
  let position = 0
  const take = () => tokens[position++]
  const peek = () => tokens[position]
  const atom = (): number => {
    const token = take()
    let value: number
    if (token === '+' || token === '-') value = (token === '-' ? -1 : 1) * atom()
    else if (token === '(') { value = sum(); if (take() !== ')') throw new Error('Check the parentheses in your calculation.') }
    else { if (!token || !/^(\d|\.)/.test(token)) throw new Error('Check the numbers and operators in your calculation.'); value = Number(token) }
    if (peek() === '%') { take(); value /= 100 }
    return value
  }
  const product = (): number => {
    let value = atom()
    while (peek() === '*' || peek() === '/') {
      const operator = take(), right = atom()
      if (operator === '/' && right === 0) throw new Error('Division by zero is undefined.')
      value = operator === '*' ? value * right : value / right
    }
    return value
  }
  const sum = (): number => {
    let value = product()
    while (peek() === '+' || peek() === '-') { const operator = take(), right = product(); value = operator === '+' ? value + right : value - right }
    return value
  }
  try {
    const value = sum()
    if (position !== tokens.length) return null
    if (!Number.isFinite(value) || Math.abs(value) > Number.MAX_SAFE_INTEGER) return 'That result exceeds the precision of the quick calculator.'
    return `${numberText(value)}. Calculated on this device.`
  } catch (error) { return error instanceof Error ? error.message : null }
}
