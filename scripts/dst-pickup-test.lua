local now, targets = 1, {}
GetTime = function() return now end
ACTIONS = { PICKUP = 'PICKUP' }
BufferedAction = function(inst, target, action) return { inst = inst, target = target, action = action } end
TheSim = { FindEntities = function() return targets end }
local function thing(prefab, x, owner, heavy)
 return { prefab = prefab, components = { inventoryitem = { canbepickedup = true, GetGrandOwner = function() return owner end } }, IsValid = function() return true end, HasTag = function(_, tag) return tag == 'heavy' and heavy end, Transform = { GetWorldPosition = function() return x, 0, 0 end } }
end
local room = true
local body = { sei = {}, components = { inventory = { CanAcceptCount = function() return room and 1 or 0 end } }, Transform = { GetWorldPosition = function() return 0, 0, 0 end } }
local pickup = assert(loadfile('native/dst-mod/sei/scripts/sei/pickup.lua'))()
targets = { thing('log', 5), thing('twigs', 2), thing('rare_gem', 1) }
local action = pickup.Next(body)
assert(action.target.prefab == 'twigs' and action.action == 'PICKUP')
assert(pickup.Next(body) == nil)
now = 6; body.sei.cmd = {kind = 'gather'}; assert(pickup.Next(body) == nil)
body.sei.cmd = nil; body.sei.paused = true; assert(pickup.Next(body) == nil)
body.sei.paused = false; targets = { thing('log', 2, 'player'), thing('rocks', 3, nil, true) }; assert(pickup.Next(body) == nil)
now = 11; body.sei.follow = {IsValid = function() return true end, Transform = {GetWorldPosition = function() return 20, 0, 0 end}}; targets = {thing('log', 2)}; assert(pickup.Next(body) == nil)
now = 16; body.sei.follow = nil; room = false; assert(pickup.Next(body) == nil)
print('DST idle pickup test passed')
