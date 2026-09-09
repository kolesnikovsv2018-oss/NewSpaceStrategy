import { z } from 'zod';
import { CargoType, EngineType, EquipmentType, PowerSourceType } from '../entities/interfaces/ShipComponents';

// Legacy selectors, not a ShipDesign or a persistence format. Never infer a hull from these values.
export const legacyPowerTypeSchema = z.nativeEnum(PowerSourceType);
export const legacyEngineTypeSchema = z.nativeEnum(EngineType);
export const legacyCargoTypeSchema = z.nativeEnum(CargoType);
export const legacyEquipmentTypeSchema = z.nativeEnum(EquipmentType);
// Keep higher historical tiers working; reject invalid arithmetic, not arbitrary balancing tiers.
export const legacyEquipmentLevelSchema = z.number().finite().int().positive().max(Number.MAX_SAFE_INTEGER);
export const legacyShipConfigSchema = z.object({
  name: z.string().min(1).max(80).refine(value => value.trim().length > 0, 'Название не должно быть пустым'),
  powerSourceType: legacyPowerTypeSchema,
  engineType: legacyEngineTypeSchema,
  cargoType: legacyCargoTypeSchema
}).strict();

export type LegacyShipConfig = z.infer<typeof legacyShipConfigSchema>;