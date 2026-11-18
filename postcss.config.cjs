module.exports = {
  plugins: [
    require('./scripts/build/tailwind.cjs'),
    require('autoprefixer')(),
  ],
}
