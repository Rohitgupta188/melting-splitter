import mongoose from 'mongoose';

export const ImageIndex = 
  mongoose.models.ImageIndex || 
  mongoose.model('ImageIndex', new mongoose.Schema({}, { 
    collection: 'image_index', 
    strict: false 
  }));

