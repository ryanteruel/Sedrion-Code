// raster.js
const GeoTIFF = require('geotiff');

let reliefImage = null;
let reliefRaster = null;
let bbox = null;

async function loadReliefRaster(path) {
  const tiff = await GeoTIFF.fromFile(path);
  reliefImage = await tiff.getImage();
  reliefRaster = await reliefImage.readRasters();
  bbox = reliefImage.getBoundingBox(); // [minX, minY, maxX, maxY] in lon/lat
  console.log('Relief raster loaded, bbox:', bbox);
}

function sampleElevationRelief(lat, lon) {
  const [minX, minY, maxX, maxY] = bbox;

  // bounds check — reject coordinates outside the tile
  if (lon < minX || lon > maxX || lat < minY || lat > maxY) {
    throw new Error('Coordinates fall outside the covered elevation data area');
  }

  const width = reliefImage.getWidth();
  const height = reliefImage.getHeight();

  // convert lon/lat to pixel col/row
  const col = Math.floor(((lon - minX) / (maxX - minX)) * width);
  const row = Math.floor(((maxY - lat) / (maxY - minY)) * height); // Y is flipped — raster row 0 is the top (north)

  const pixelIndex = row * width + col;
  const value = reliefRaster[0][pixelIndex]; // band 1

  return value;
}

module.exports = { loadReliefRaster, sampleElevationRelief };