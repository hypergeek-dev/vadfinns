import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import sharp from 'sharp';

const ALLOWED_EXTENSIONS = new Set(['.jpg', '.jpeg', '.png', '.webp']);

const SWEDISH_NAMES = new Map([
  ['Classic Spaghetti Bolognese with Parmesan', 'Spagetti med köttfärssås'],
  ['Creamy Macaroni and Golden Corn', 'Makaroner och majs'],
  ['Creamy Yogurt with Chocolate Cereal Balls', 'Yoghurt med chokladflingor'],
  ['Crispy Buffalo Wings on a Plate', 'Kycklingvingar'],
  ['Crispy-Edged Sunny-Side-Up Egg', 'Stekt ägg'],
  ['Fresh Apple on White Plate', 'Äpple'],
  ['Fresh Peeled Cucumber Slices on Plate', 'Gurka'],
  ['Glossy Ketchup Hot Dog Close-Up', 'Korv med bröd'],
  ['Golden Bacon Egg Stir-Fried Noodles', 'Nudlar med bacon och ägg'],
  ['Golden Belgian Waffle on White Plate', 'Våffla'],
  ['Golden Crackling Pork Roast in a Swedish Kitchen', 'Fläskstek'],
  ['Golden Crepe Pancake Stack', 'Pannkakor'],
  ['Golden French Fries on a White Plate', 'Pommes frites'],
  ['Golden Ham and Mozzarella Pizza', 'Pizza med skinka'],
  ['Golden-Browned Layered Lasagna Slice', 'Lasagne'],
  ['Gooey Cheddar Cheeseburger Close-Up', 'Hamburgare'],
  ['Single Banana on White Plate', 'Banan'],
  ['Swedish Meatballs with Mashed Potatoes', 'Köttbullar med potatismos'],
  ['Turkey on Puffed Rice Cake', 'Riskaka med kalkon']
]);

function safeBaseName(filename) {
  return path.basename(filename, path.extname(filename)).replace(/ \(\d+\)$/, '').trim();
}

function foodName(filename) {
  const base = safeBaseName(filename).replace(/[-_]+/g, ' ');
  return SWEDISH_NAMES.get(base) || base;
}

function publicFood(food) {
  return {
    id: food.id,
    name: food.name,
    available: food.available,
    order: food.order,
    imageUrl: `/media/${food.image}`,
    thumbnailUrl: `/media/${food.thumbnail}`
  };
}

export class FoodStore {
  constructor({ rootDir, seedDir }) {
    this.rootDir = rootDir;
    this.seedDir = seedDir;
    this.dataFile = path.join(rootDir, 'foods.json');
    this.mediaDir = path.join(rootDir, 'media');
    this.foods = [];
    this.writeChain = Promise.resolve();
  }

  async init() {
    await mkdir(this.mediaDir, { recursive: true });
    try {
      this.foods = JSON.parse(await readFile(this.dataFile, 'utf8'));
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      this.foods = [];
    }
    await this.importSeeds();
    return this;
  }

  list({ availableOnly = false } = {}) {
    return this.foods
      .filter((food) => !availableOnly || food.available)
      .sort((a, b) => a.order - b.order || a.name.localeCompare(b.name, 'sv'))
      .map(publicFood);
  }

  async importSeeds() {
    let entries = [];
    try {
      entries = await readdir(this.seedDir, { withFileTypes: true });
    } catch (error) {
      if (error.code === 'ENOENT') return;
      throw error;
    }
    for (const entry of entries) {
      if (!entry.isFile() || !ALLOWED_EXTENSIONS.has(path.extname(entry.name).toLowerCase())) continue;
      const buffer = await readFile(path.join(this.seedDir, entry.name));
      const hash = createHash('sha256').update(buffer).digest('hex');
      if (this.foods.some((food) => food.hash === hash)) continue;
      await this.addImage({ buffer, name: foodName(entry.name), hash, initiallyAvailable: true });
    }
  }

  async addImage({ buffer, name, hash, initiallyAvailable = false }) {
    const actualHash = hash || createHash('sha256').update(buffer).digest('hex');
    if (this.foods.some((food) => food.hash === actualHash)) {
      const error = new Error('Bilden finns redan i biblioteket.');
      error.status = 409;
      throw error;
    }
    await sharp(buffer).metadata();
    const id = randomUUID();
    const image = `${id}.webp`;
    const thumbnail = `${id}-thumb.webp`;
    await Promise.all([
      sharp(buffer).rotate().resize({ width: 1800, height: 1800, fit: 'inside', withoutEnlargement: true }).webp({ quality: 88 }).toFile(path.join(this.mediaDir, image)),
      sharp(buffer).rotate().resize({ width: 520, height: 520, fit: 'inside', withoutEnlargement: true }).webp({ quality: 80 }).toFile(path.join(this.mediaDir, thumbnail))
    ]);
    const food = {
      id,
      name: String(name || 'Namnlös mat').trim().slice(0, 80) || 'Namnlös mat',
      available: initiallyAvailable,
      order: this.foods.length,
      image,
      thumbnail,
      hash: actualHash
    };
    this.foods.push(food);
    await this.persist();
    return publicFood(food);
  }

  async update(id, changes) {
    const food = this.foods.find((item) => item.id === id);
    if (!food) return null;
    if (typeof changes.available === 'boolean') food.available = changes.available;
    if (typeof changes.name === 'string') {
      const name = changes.name.trim().slice(0, 80);
      if (!name) {
        const error = new Error('Namnet får inte vara tomt.');
        error.status = 400;
        throw error;
      }
      food.name = name;
    }
    await this.persist();
    return publicFood(food);
  }

  async move(id, direction) {
    const ordered = this.foods.sort((a, b) => a.order - b.order);
    const index = ordered.findIndex((food) => food.id === id);
    const target = direction === 'up' ? index - 1 : index + 1;
    if (index < 0 || target < 0 || target >= ordered.length) return index < 0 ? null : publicFood(ordered[index]);
    [ordered[index], ordered[target]] = [ordered[target], ordered[index]];
    ordered.forEach((food, order) => { food.order = order; });
    this.foods = ordered;
    await this.persist();
    return publicFood(ordered[target]);
  }

  async replaceImage(id, buffer) {
    const food = this.foods.find((item) => item.id === id);
    if (!food) return null;
    const hash = createHash('sha256').update(buffer).digest('hex');
    if (this.foods.some((item) => item.id !== id && item.hash === hash)) {
      const error = new Error('Bilden finns redan i biblioteket.');
      error.status = 409;
      throw error;
    }
    await sharp(buffer).metadata();
    const imageTemp = path.join(this.mediaDir, `${food.id}-new.webp`);
    const thumbTemp = path.join(this.mediaDir, `${food.id}-thumb-new.webp`);
    await Promise.all([
      sharp(buffer).rotate().resize({ width: 1800, height: 1800, fit: 'inside', withoutEnlargement: true }).webp({ quality: 88 }).toFile(imageTemp),
      sharp(buffer).rotate().resize({ width: 520, height: 520, fit: 'inside', withoutEnlargement: true }).webp({ quality: 80 }).toFile(thumbTemp)
    ]);
    await Promise.all([
      rename(imageTemp, path.join(this.mediaDir, food.image)),
      rename(thumbTemp, path.join(this.mediaDir, food.thumbnail))
    ]);
    food.hash = hash;
    await this.persist();
    return publicFood(food);
  }

  async remove(id) {
    const index = this.foods.findIndex((item) => item.id === id);
    if (index < 0) return false;
    const [food] = this.foods.splice(index, 1);
    this.foods.sort((a, b) => a.order - b.order).forEach((item, order) => { item.order = order; });
    await this.persist();
    await Promise.all([
      rm(path.join(this.mediaDir, food.image), { force: true }),
      rm(path.join(this.mediaDir, food.thumbnail), { force: true })
    ]);
    return true;
  }

  persist() {
    const snapshot = JSON.stringify(this.foods, null, 2);
    const temp = `${this.dataFile}.tmp`;
    this.writeChain = this.writeChain.then(async () => {
      await writeFile(temp, snapshot, 'utf8');
      await rename(temp, this.dataFile);
    });
    return this.writeChain;
  }
}
