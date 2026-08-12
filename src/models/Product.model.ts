import mongoose from 'mongoose';

export const Product = 
  mongoose.models.Product || 
  mongoose.model('Product', new mongoose.Schema({}, { 
    collection: 'catalogs', 
    strict: false 
  }));