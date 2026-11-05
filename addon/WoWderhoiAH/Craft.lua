-- Craft capture: a finished craft is the only clean production label.
--
-- The client reports which recipe started and which item(s) it produced,
-- with the real quantity (multicraft and crits included). Materials come
-- from the compiled recipe table, and the ledger prices them from its own
-- FIFO lots -- the capture never guesses a cost.
--
-- A craft whose recipe cannot be resolved is counted as unmapped and kept
-- out of the ledger: booking it against the wrong materials would corrupt
-- the product's cost basis silently.

local ADDON_NAME, WAH = ...

local Craft = {
  lastRecipe = nil,
  recorded = 0,
  unmapped = 0
}

-- A recipe whose product the dataset names must produce the crafted item;
-- a stale craft-begin id or an id that collides with the dataset's own
-- numbering would otherwise consume a different recipe's materials. A
-- recipe without a recorded product cannot be checked and is accepted as
-- before rather than losing the capture.
local function produces(recipe, productItemId)
  return not recipe.p or not productItemId or recipe.p == productItemId
end

local function recipeFor(recipeSpellID, productItemId)
  local recipes = WAH.RECIPES or {}
  local recipe = recipeSpellID and recipes[recipeSpellID]
  if recipe and produces(recipe, productItemId) then return recipe end
  -- The dataset id and the recipe spell id are not guaranteed to be the
  -- same field. Ask the client for the recipe id the dataset uses.
  if recipeSpellID and C_TradeSkillUI and C_TradeSkillUI.GetRecipeInfo then
    local ok, info = pcall(C_TradeSkillUI.GetRecipeInfo, recipeSpellID)
    local resolved = ok and info and info.recipeID and recipes[info.recipeID]
    if resolved and produces(resolved, productItemId) then return resolved end
  end
  -- Last resort: a product produced by exactly one known recipe.
  local byProduct = WAH.RECIPE_BY_PRODUCT or {}
  local recipeId = productItemId and byProduct[productItemId]
  return recipeId and recipes[recipeId] or nil
end

local function recordCraft(data)
  if WAH.settings and WAH.settings.craftCapture == false then return end
  if type(data) ~= "table" or not data.itemID then return end
  local quantity = data.quantity or 1
  if quantity <= 0 then return end
  local recipe = recipeFor(Craft.lastRecipe, data.itemID)
  if not recipe then
    Craft.unmapped = Craft.unmapped + 1
    return
  end
  local mats = {}
  for _, material in ipairs(recipe.m or {}) do
    mats[#mats + 1] = { itemId = material[1], qty = material[2] }
  end
  WAH.recordEvent({
    k = "craft",
    itemId = data.itemID,
    qty = quantity,
    mats = mats
  })
  Craft.recorded = Craft.recorded + 1
end

local frame = CreateFrame("Frame")
frame:RegisterEvent("TRADE_SKILL_CRAFT_BEGIN")
frame:RegisterEvent("TRADE_SKILL_ITEM_CRAFTED_RESULT")
frame:SetScript("OnEvent", function(_, event, payload)
  if event == "TRADE_SKILL_CRAFT_BEGIN" then
    Craft.lastRecipe = payload
  elseif event == "TRADE_SKILL_ITEM_CRAFTED_RESULT" then
    recordCraft(payload)
  end
end)

Craft.diagnostics = function()
  return {
    string.format("craft: %d recorded, %d unmapped, last recipe %s",
      Craft.recorded, Craft.unmapped, tostring(Craft.lastRecipe)),
    string.format("craft: recipe table %d entries",
      (function() local n = 0 for _ in pairs(WAH.RECIPES or {}) do n = n + 1 end return n end)())
  }
end

WAH.Craft = Craft
